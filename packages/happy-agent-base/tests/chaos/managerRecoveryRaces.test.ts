import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    AgentBaseKV,
    AgentProviders,
    AgentStorage,
    AgentSystemLocal,
    type AgentFeature,
    type AgentFeatureConstructor,
} from "../../sources/index.js";
import { askedIn, transcriptOf } from "../gym/chaosWorld.js";
import { InMemoryPersistence } from "../gym/InMemoryPersistence.js";
import { ScriptedProvider } from "../gym/ScriptedProvider.js";
import { providersOf, queued, textTurn, user } from "../gym/fixtures.js";

const ctx = createRootContext().named("happy-agent-base-manager-recovery-races");

interface Deferred {
    readonly promise: Promise<void>;
    readonly resolve: () => void;
}

function deferred(): Deferred {
    let resolve!: () => void;
    const promise = new Promise<void>((settle) => {
        resolve = settle;
    });
    return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function managerKV(persistence: InMemoryPersistence): AgentBaseKV {
    return new AgentBaseKV(persistence, "agents.", async (operationCtx, work) =>
        work(operationCtx),
    );
}

function collection(
    managerPersistence: InMemoryPersistence,
    agentPersistence: InMemoryPersistence,
    provider: ScriptedProvider,
    features: readonly AgentFeatureConstructor[] = [],
): AgentSystemLocal {
    return new AgentSystemLocal({
        features,
        storage: new AgentStorage({
            kv: managerKV(managerPersistence),
            persistence: () => agentPersistence,
        }),
        providers: providersOf(provider),
        provider: "scripted",
        models: [],
    });
}

/**
 * These scenarios cross the boundary between a live Agent, its collection's discovery index,
 * and another collection over the same durable identity. A per-instance lock cannot make those
 * stores or owners agree; each test therefore fixes the exact shared snapshot both owners see.
 */
describe("manager recovery and live-owner consistency", () => {
    it("consumes one durable queue entry exactly once across two collections", async () => {
        const managerDisk = new InMemoryPersistence();
        const agentDisk = new InMemoryPersistence();
        managerDisk.values.set("agents.config.shared", {});
        managerDisk.values.set("agents.active.shared", true);
        agentDisk.values.set("send.0001", queued(user("consume once")));

        const bothQueueSnapshotsTaken = deferred();
        const originalReadValues = agentDisk.readValues.bind(agentDisk);
        let queueReads = 0;
        agentDisk.readValues = async (readCtx, prefix) => {
            if (prefix === "send." && queueReads < 2) {
                const snapshot = await originalReadValues(readCtx, prefix);
                queueReads += 1;
                if (queueReads === 2) bothQueueSnapshotsTaken.resolve();
                await bothQueueSnapshotsTaken.promise;
                return snapshot;
            }
            return await originalReadValues(readCtx, prefix);
        };

        const firstProvider = new ScriptedProvider([textTurn("first owner")]);
        const secondProvider = new ScriptedProvider([textTurn("second owner")]);
        const first = collection(managerDisk, agentDisk, firstProvider);
        const second = collection(managerDisk, agentDisk, secondProvider);
        const starts = Promise.all([first.start(ctx), second.start(ctx)]);
        await bothQueueSnapshotsTaken.promise;
        await starts;

        const [firstAgent, secondAgent] = await Promise.all([
            first.resolve(ctx, "shared"),
            second.resolve(ctx, "shared"),
        ]);
        await Promise.all([firstAgent.waitForIdle(), secondAgent.waitForIdle()]);
        const totalRequests = [firstProvider, secondProvider].flatMap((provider) =>
            provider.sessions.flatMap((session) => session.requests),
        );
        const durableQuestions = askedIn(transcriptOf(agentDisk));
        await Promise.all([firstAgent.close(), secondAgent.close()]);

        expect({
            totalRequests: totalRequests.length,
            durableQuestions,
        }).toEqual({
            totalRequests: 1,
            durableQuestions: ["consume once"],
        });
    });

    it("refreshes durable settings and history before a stale live owner continues", async () => {
        const managerDisk = new InMemoryPersistence();
        const agentDisk = new InMemoryPersistence();
        managerDisk.values.set("agents.config.shared", {});

        const oldProvider = new ScriptedProvider([textTurn("stale answer")]);
        const newProvider = new ScriptedProvider([
            textTurn("answer after switch"),
            textTurn("answer after follow-up"),
        ]);
        const providers = new AgentProviders();
        providers.add("old", oldProvider, "codex");
        providers.add("new", newProvider, "claude");
        const owner = () =>
            new AgentSystemLocal({
                features: [],
                storage: new AgentStorage({
                    kv: managerKV(managerDisk),
                    persistence: () => agentDisk,
                }),
                providers,
                provider: "old",
                models: [],
            });
        const staleOwner = owner();
        const writingOwner = owner();
        const [staleAgent, writingAgent] = await Promise.all([
            staleOwner.resolve(ctx, "shared"),
            writingOwner.resolve(ctx, "shared"),
        ]);
        await Promise.all([staleAgent.waitForIdle(), writingAgent.waitForIdle()]);

        await writingOwner.send(ctx, "shared", user("switch and append"), {
            await: true,
            provider: "new",
            model: "new-model",
        });
        await writingAgent.waitForIdle();
        await staleOwner.send(ctx, "shared", user("continue from durable state"), { await: true });
        await staleAgent.waitForIdle();

        const requests = [
            ...oldProvider.sessions.flatMap((session) =>
                session.requests.map((request) => ({ provider: "old", request })),
            ),
            ...newProvider.sessions.flatMap((session) =>
                session.requests.map((request) => ({ provider: "new", request })),
            ),
        ];
        const continued = requests.find(({ request }) =>
            askedIn(request.context.messages).includes("continue from durable state"),
        );
        await Promise.all([staleAgent.close(), writingAgent.close()]);

        expect({
            provider: continued?.provider,
            model: continued?.request.model,
            questions: continued === undefined ? [] : askedIn(continued.request.context.messages),
        }).toEqual({
            provider: "new",
            model: "new-model",
            questions: ["switch and append", "continue from durable state"],
        });
    });

    it("does not publish a durable identity when feature loading rejects creation", async () => {
        const managerDisk = new InMemoryPersistence();
        const agentDisk = new InMemoryPersistence();
        let loadAttempts = 0;
        const failsOnce: AgentFeatureConstructor = class implements AgentFeature {
            readonly name = "fails-once";

            load(_loadCtx: Context): Promise<void> {
                loadAttempts += 1;
                return loadAttempts === 1
                    ? Promise.reject(new Error("feature load failed"))
                    : Promise.resolve();
            }
        };
        const first = collection(managerDisk, agentDisk, new ScriptedProvider([]), [failsOnce]);

        await expect(first.createWithId(ctx, "ghost", {})).rejects.toThrow("feature load failed");
        const configAfterFailure = await first.config(ctx, "ghost");

        // A fresh process must agree that the rejected creation never happened. The caller can
        // then retry the same creation rather than inheriting an identity it never received.
        const restarted = collection(managerDisk, agentDisk, new ScriptedProvider([]), [failsOnce]);
        const ghostResolution = await Promise.allSettled([restarted.resolve(ctx, "ghost")]);
        const retry = await Promise.allSettled([first.createWithId(ctx, "ghost", {})]);
        const liveAgents = [...ghostResolution, ...retry].flatMap((outcome) =>
            outcome.status === "fulfilled" ? [outcome.value] : [],
        );
        await Promise.all(
            liveAgents.map(async (agent) => {
                await agent.waitForIdle();
                await agent.close();
            }),
        );

        expect({
            configAfterFailure,
            resolveStatus: ghostResolution[0]?.status,
            retryStatus: retry[0]?.status,
        }).toEqual({
            configAfterFailure: undefined,
            resolveStatus: "rejected",
            retryStatus: "fulfilled",
        });
    });
});
