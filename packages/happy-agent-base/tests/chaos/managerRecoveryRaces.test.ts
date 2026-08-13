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
    it("does not acknowledge a durable message before a restart can discover its agent", async () => {
        const managerDisk = new InMemoryPersistence();
        const agentDisk = new InMemoryPersistence();
        const originalProvider = new ScriptedProvider([textTurn("original answer")]);
        const restartedProvider = new ScriptedProvider([textTurn("recovered answer")]);
        const original = collection(managerDisk, agentDisk, originalProvider);
        const originalAgent = await original.create(ctx, "recoverable", {});
        await originalAgent.waitForIdle();

        const activeWriteStarted = deferred();
        const releaseActiveWrite = deferred();
        const originalWriteValue = managerDisk.writeValue.bind(managerDisk);
        let blockNextActivation = true;
        managerDisk.writeValue = async (writeCtx, key, value) => {
            if (key === "agents.active.recoverable" && blockNextActivation) {
                blockNextActivation = false;
                activeWriteStarted.resolve();
                await releaseActiveWrite.promise;
            }
            await originalWriteValue(writeCtx, key, value);
        };

        let accepted = false;
        const sending = original
            .send(ctx, "recoverable", user("survive restart"), { await: true })
            .then(() => {
                accepted = true;
            });
        await activeWriteStarted.promise;
        await flushMicrotasks();

        // The queue write already landed. Recreate the collection at precisely this process-loss
        // boundary, while publication in the manager's active index is still withheld.
        const durableQueue = [...agentDisk.values.keys()].filter((key) => key.startsWith("send."));
        const acceptedBeforeDiscoverable = accepted;
        const restarted = collection(managerDisk, agentDisk, restartedProvider);
        await restarted.start(ctx);
        await flushMicrotasks();
        const recoveredRequests = restartedProvider.sessions.flatMap((session) => session.requests);

        releaseActiveWrite.resolve();
        await sending;
        await originalAgent.waitForIdle();
        await originalAgent.close();

        // A message may be durable but unacknowledged while discovery catches up. Once the send
        // promise resolves, however, losing the process must not hide that accepted work.
        expect({
            durableQueue: durableQueue.length,
            acceptedBeforeDiscoverable,
            recoveredRequests: recoveredRequests.length,
        }).toEqual({
            durableQueue: 1,
            acceptedBeforeDiscoverable: false,
            recoveredRequests: 0,
        });
    });

    it("keeps an agent discoverable when a follow-up arrives during active-marker deletion", async () => {
        const managerDisk = new InMemoryPersistence();
        const agentDisk = new InMemoryPersistence();
        const originalProvider = new ScriptedProvider([
            textTurn("first answer"),
            textTurn("follow-up answer"),
        ]);
        const restartedProvider = new ScriptedProvider([textTurn("restarted follow-up")]);
        const original = collection(managerDisk, agentDisk, originalProvider);
        const originalAgent = await original.create(ctx, "settling", {});
        await originalAgent.waitForIdle();

        const deleteStarted = deferred();
        const allowDeleteCommit = deferred();
        const deleteCommitted = deferred();
        const allowDeleteReturn = deferred();
        const originalDeleteValue = managerDisk.deleteValue.bind(managerDisk);
        let blockNextDeletion = true;
        managerDisk.deleteValue = async (deleteCtx, key) => {
            if (key === "agents.active.settling" && blockNextDeletion) {
                blockNextDeletion = false;
                deleteStarted.resolve();
                await allowDeleteCommit.promise;
                await originalDeleteValue(deleteCtx, key);
                deleteCommitted.resolve();
                await allowDeleteReturn.promise;
                return;
            }
            await originalDeleteValue(deleteCtx, key);
        };

        await original.send(ctx, "settling", user("first"), { await: true });
        await deleteStarted.promise;
        await original.send(ctx, "settling", user("accepted while settling"), { await: true });

        // Commit the stale deletion but hold the old loop before its finally block can notice
        // the follow-up and publish a new active span.
        allowDeleteCommit.resolve();
        await deleteCommitted.promise;
        const durableFollowUp = [...agentDisk.values.values()].some(
            (value) =>
                JSON.stringify(value) === JSON.stringify(queued(user("accepted while settling"))),
        );

        let restartLoads = 0;
        const restarted = new AgentSystemLocal({
            features: [],
            storage: new AgentStorage({
                kv: managerKV(managerDisk),
                persistence: () => {
                    restartLoads += 1;
                    return agentDisk;
                },
            }),
            providers: providersOf(restartedProvider),
            provider: "scripted",
            models: [],
        });
        await restarted.start(ctx);
        if (restartLoads > 0) {
            await (await restarted.resolve(ctx, "settling")).waitForIdle();
        }
        const restartedQuestions = restartedProvider.sessions.flatMap((session) =>
            session.requests.flatMap((request) => askedIn(request.context.messages)),
        );

        allowDeleteReturn.resolve();
        await originalAgent.waitForIdle();
        await originalAgent.close();
        if (restartLoads > 0) await (await restarted.resolve(ctx, "settling")).close();

        expect({
            durableFollowUp,
            restartLoads,
            restartedQuestions,
        }).toEqual({
            durableFollowUp: true,
            restartLoads: 1,
            restartedQuestions: ["first", "accepted while settling"],
        });
    });

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

        await expect(first.create(ctx, "ghost", {})).rejects.toThrow("feature load failed");
        const configAfterFailure = await first.config(ctx, "ghost");

        // A fresh process must agree that the rejected creation never happened. The caller can
        // then retry the same creation rather than inheriting an identity it never received.
        const restarted = collection(managerDisk, agentDisk, new ScriptedProvider([]), [failsOnce]);
        const ghostResolution = await Promise.allSettled([restarted.resolve(ctx, "ghost")]);
        const retry = await Promise.allSettled([first.create(ctx, "ghost", {})]);
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
