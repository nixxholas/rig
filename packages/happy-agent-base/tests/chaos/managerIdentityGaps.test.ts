import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    agentFeatureConfig,
    agentSystem as agentsFromContext,
    AgentKV,
    AgentStorage,
    AgentSystemLocal,
    type Agent,
    type AgentConfig,
    type AgentFeature,
} from "../../sources/index.js";
import { askedIn } from "../gym/chaosWorld.js";
import { InMemoryPersistence } from "../gym/InMemoryPersistence.js";
import { ScriptedProvider } from "../gym/ScriptedProvider.js";
import { providersOf, textTurn, user } from "../gym/fixtures.js";

const ctx = createRootContext().named("happy-agent-base-manager-identity-gaps");

interface Deferred {
    readonly promise: Promise<void>;
    readonly resolve: () => void;
}

type Outcome<Value> =
    | { readonly status: "fulfilled"; readonly value: Value }
    | { readonly status: "rejected"; readonly reason: unknown };

function deferred(): Deferred {
    let resolve!: () => void;
    const promise = new Promise<void>((settle) => {
        resolve = settle;
    });
    return { promise, resolve };
}

function outcomeOf<Value>(promise: Promise<Value>): Promise<Outcome<Value>> {
    return promise.then(
        (value) => ({ status: "fulfilled", value }),
        (reason: unknown) => ({ status: "rejected", reason }),
    );
}

async function observedWithin<Value>(
    promise: Promise<Value>,
    milliseconds = 40,
): Promise<{ readonly status: "settled"; readonly value: Value } | { readonly status: "pending" }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ readonly status: "pending" }>((resolve) => {
        timer = setTimeout(() => resolve({ status: "pending" }), milliseconds);
    });
    const observed = await Promise.race([
        promise.then((value) => ({ status: "settled" as const, value })),
        timeout,
    ]);
    if (timer !== undefined) clearTimeout(timer);
    return observed;
}

/** Every question the provider was actually asked, across all of its sessions. */
function questionsAskedOf(provider: ScriptedProvider): readonly string[] {
    return provider.sessions.flatMap((session) =>
        session.requests.flatMap((request) => askedIn(request.context.messages)),
    );
}

/** Wait for something a run does on its own, rather than guessing how many ticks it takes. */
async function until(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 1000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error("The condition was not reached in time.");
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
}

async function flushMicrotasks(): Promise<void> {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function managerKV(persistence: InMemoryPersistence): AgentKV {
    return new AgentKV(persistence, "agentSystem.");
}

async function collection(
    managerPersistence: InMemoryPersistence,
    agentPersistence: InMemoryPersistence,
    provider: ScriptedProvider,
    features: readonly AgentFeature[] = [],
): Promise<AgentSystemLocal> {
    return await AgentSystemLocal.create(
        ctx,
        new AgentStorage({
            kv: managerKV(managerPersistence),
            persistence: () => agentPersistence,
        }),
        { features, providers: providersOf(provider), provider: "scripted", models: [] },
    );
}

function errorMessage(reason: unknown): string {
    return reason instanceof Error ? reason.message : String(reason);
}

/**
 * These scenarios exercise the collection-level consistency boundary: durable identity,
 * recovery discovery, feature construction, and deletion all span more than one live `AgentSystemLocal`
 * instance. A lock owned by only one collection cannot serialize the other owner, so every race
 * below fixes the storage boundary at which the second owner enters.
 */
describe("manager identity and recovery gaps", () => {
    it("discovers a consumed unanswered user record created between start snapshots", async () => {
        const managerDisk = new InMemoryPersistence();
        const agentDisk = new InMemoryPersistence();
        managerDisk.values.set("agentSystem.config.shared", {});
        const configSnapshotStarted = deferred();
        const releaseConfigSnapshot = deferred();
        const originalReadValues = managerDisk.readValues.bind(managerDisk);
        managerDisk.readValues = async (readCtx, prefix) => {
            if (prefix === "agentSystem.config.") {
                configSnapshotStarted.resolve();
                await releaseConfigSnapshot.promise;
            }
            return await originalReadValues(readCtx, prefix);
        };
        const provider = new ScriptedProvider([textTurn("recovered")]);
        const starting = collection(managerDisk, agentDisk, provider);
        await configSnapshotStarted.promise;
        // The configuration snapshot is already taken. A previous process now commits the
        // consumed user record, and the record of the answer it owes, and disappears.
        agentDisk.records.push({ type: "user", message: user("answer after restart") });
        agentDisk.values.set("owed", { stage: "inference" });
        releaseConfigSnapshot.resolve();
        const restarted = await starting;
        // Nobody resolves the agent. If starting the collection discovered the work committed
        // after its snapshot, the answer that agent owes is asked for without being prompted.
        await until(() => questionsAskedOf(provider).length > 0);
        const agent = await restarted.resolve(ctx, "shared");
        await agent.waitForIdle();
        await agent.close();

        expect(questionsAskedOf(provider)).toEqual(["answer after restart"]);
    });

    it("starts over a store another owner is mid-write on without losing its work", async () => {
        const managerDisk = new InMemoryPersistence();
        const agentDisk = new InMemoryPersistence();
        const provider = new ScriptedProvider([textTurn("live answer")]);
        const liveOwner = await collection(managerDisk, agentDisk, provider);
        const live = await liveOwner.create(ctx, {});
        await live.waitForIdle();

        const liveWriteStarted = deferred();
        const releaseLiveWrite = deferred();
        const originalWriteValue = agentDisk.writeValue.bind(agentDisk);
        let liveOperationActive = false;
        agentDisk.writeValue = async (writeCtx, key, value) => {
            if (key.startsWith("send.") && !liveOperationActive) {
                liveOperationActive = true;
                liveWriteStarted.resolve();
                await releaseLiveWrite.promise;
                await originalWriteValue(writeCtx, key, value);
                liveOperationActive = false;
                return;
            }
            await originalWriteValue(writeCtx, key, value);
        };

        const sending = liveOwner.send(ctx, live.id, user("live work"), { await: true });
        await liveWriteStarted.promise;
        // A second owner comes up over the same store while that message is still being
        // admitted. What it reads is one key, written in one step, so it never waits for a
        // write it has nothing to do with — and it never sees half of one either.
        const starting = outcomeOf(collection(managerDisk, agentDisk, new ScriptedProvider([])));
        const earlyStart = await observedWithin(starting);
        releaseLiveWrite.resolve();
        await Promise.all([sending, starting]);
        await live.waitForIdle();
        await live.close();

        expect({
            startSettledWhileWriteBlocked: earlyStart.status === "settled",
            questions: askedIn(
                provider.sessions.flatMap((session) =>
                    session.requests.flatMap((request) => request.context.messages),
                ),
            ),
        }).toEqual({
            startSettledWhileWriteBlocked: true,
            questions: ["live work"],
        });
    });

    it("linearizes deletion with another manager resolving the same identity", async () => {
        const managerDisk = new InMemoryPersistence();
        const agentDisk = new InMemoryPersistence();
        managerDisk.values.set("agentSystem.config.shared", {});
        const resolvingOwner = await collection(managerDisk, agentDisk, new ScriptedProvider([]));
        const deletingOwner = await collection(managerDisk, agentDisk, new ScriptedProvider([]));

        // The resolution is suspended where it reads the agent's own store, which is the point
        // the deletion of that identity has to be ordered against.
        const resolverLoadStarted = deferred();
        const releaseResolverLoad = deferred();
        const originalReadValues = agentDisk.readValues.bind(agentDisk);
        let blockFirstFlagRead = true;
        agentDisk.readValues = async (readCtx, prefix) => {
            if (prefix === "owed" && blockFirstFlagRead) {
                blockFirstFlagRead = false;
                resolverLoadStarted.resolve();
                await releaseResolverLoad.promise;
            }
            return await originalReadValues(readCtx, prefix);
        };

        const resolution = outcomeOf(resolvingOwner.resolve(ctx, "shared"));
        await resolverLoadStarted.promise;
        await deletingOwner.delete(ctx, "shared");
        releaseResolverLoad.resolve();
        const resolutionOutcome = await resolution;

        const durableConfig = await resolvingOwner.config(ctx, "shared");
        const restarted = await collection(managerDisk, agentDisk, new ScriptedProvider([]));
        const restartOutcome = await outcomeOf(restarted.resolve(ctx, "shared"));
        const linearized =
            resolutionOutcome.status === "rejected" ||
            (durableConfig !== undefined && restartOutcome.status === "fulfilled");
        const liveAgents = [resolutionOutcome, restartOutcome].flatMap((outcome) =>
            outcome.status === "fulfilled" ? [outcome.value] : [],
        );
        await Promise.all(liveAgents.map((agent) => agent.close()));

        expect(linearized).toBe(true);
    });

    it("copies nested creation config before caller mutation can diverge memory from storage", async () => {
        const managerDisk = new InMemoryPersistence();
        const agentDisk = new InMemoryPersistence();
        let observedSetting: unknown;
        const recorder: AgentFeature = new (class implements AgentFeature {
            readonly name = "recorder";

            instructions(hookCtx: Context): string {
                observedSetting = agentFeatureConfig(hookCtx, "recorder")?.label;
                return "";
            }
        })();
        const owner = await collection(
            managerDisk,
            agentDisk,
            new ScriptedProvider([textTurn("answered")]),
            [recorder],
        );
        const config: AgentConfig = {
            features: { recorder: { label: "original" } },
        };

        const creation = owner.create(ctx, config);
        // The caller goes on editing the object it passed while the creation is still running.
        const callerSettings = config.features?.recorder;
        if (callerSettings !== undefined) callerSettings.label = "mutated by caller";
        const agent = await creation;
        await agent.send(ctx, user("go"), { await: true });
        await agent.waitForIdle();
        const durableConfig = await owner.config(ctx, agent.id);
        await agent.close();

        expect({
            durableLabel: durableConfig?.features?.recorder?.label,
            observedSetting,
        }).toEqual({
            durableLabel: "original",
            observedSetting: "original",
        });
    });
});
