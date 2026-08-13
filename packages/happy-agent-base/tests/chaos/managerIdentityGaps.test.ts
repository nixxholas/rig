import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    agentFeatureConfig,
    agentSystem as agentsFromContext,
    AgentBaseKV,
    AgentStorage,
    AgentSystemLocal,
    type AgentConfig,
    type AgentFeature,
    type AgentFeatureConstructor,
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

async function flushMicrotasks(): Promise<void> {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function managerKV(persistence: InMemoryPersistence): AgentBaseKV {
    return new AgentBaseKV(persistence, "agentSystem.", async (operationCtx, work) =>
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
    it("never leaves an observer holding an agent whose provisional identity was rolled back", async () => {
        const managerDisk = new InMemoryPersistence();
        const agentDisk = new InMemoryPersistence();
        const failingLoadStarted = deferred();
        const releaseFailingLoad = deferred();
        const observerReadConfig = deferred();
        const failAfterRelease: AgentFeatureConstructor = class implements AgentFeature {
            readonly name = "fail-after-release";

            async load(): Promise<void> {
                failingLoadStarted.resolve();
                await releaseFailingLoad.promise;
                throw new Error("creator failed");
            }
        };
        const creator = collection(managerDisk, agentDisk, new ScriptedProvider([]), [
            failAfterRelease,
        ]);
        const observer = collection(managerDisk, agentDisk, new ScriptedProvider([]));
        const originalReadValues = managerDisk.readValues.bind(managerDisk);
        managerDisk.readValues = async (readCtx, prefix) => {
            const entries = await originalReadValues(readCtx, prefix);
            if (prefix === "agentSystem.config.shared") observerReadConfig.resolve();
            return entries;
        };

        const creation = outcomeOf(
            creator.createWithId(ctx, "shared", {
                features: { identity: { generation: "provisional" } },
            }),
        );
        await failingLoadStarted.promise;
        const resolution = outcomeOf(observer.resolve(ctx, "shared"));
        await observerReadConfig.promise;
        releaseFailingLoad.resolve();
        const [creationOutcome, resolutionOutcome] = await Promise.all([creation, resolution]);

        const durableConfig = await observer.config(ctx, "shared");
        const restarted = collection(managerDisk, agentDisk, new ScriptedProvider([]));
        const restartedResolution = await outcomeOf(restarted.resolve(ctx, "shared"));
        const observerWasOrphaned =
            resolutionOutcome.status === "fulfilled" &&
            (durableConfig === undefined || restartedResolution.status === "rejected");
        const agentSystem = [resolutionOutcome, restartedResolution].flatMap((outcome) =>
            outcome.status === "fulfilled" ? [outcome.value] : [],
        );
        await Promise.all(agentSystem.map((agent) => agent.close()));

        expect({
            creator: creationOutcome.status,
            observerWasOrphaned,
        }).toEqual({
            creator: "rejected",
            observerWasOrphaned: false,
        });
    });

    it("does not let a stale creation rollback delete an ABA successor identity", async () => {
        const managerDisk = new InMemoryPersistence();
        const agentDisk = new InMemoryPersistence();
        const releaseFailure = deferred();
        const staleRollbackReachedDelete = deferred();
        const releaseStaleRollback = deferred();
        const failAfterRelease: AgentFeatureConstructor = class implements AgentFeature {
            readonly name = "failing-creator";

            async load(): Promise<void> {
                await releaseFailure.promise;
                throw new Error("first generation failed");
            }
        };
        const first = collection(managerDisk, agentDisk, new ScriptedProvider([]), [
            failAfterRelease,
        ]);
        const successorOwner = collection(managerDisk, agentDisk, new ScriptedProvider([]));
        const originalDeleteValue = managerDisk.deleteValue.bind(managerDisk);
        let blockStaleConfigDelete = true;
        managerDisk.deleteValue = async (deleteCtx, key) => {
            if (key === "agentSystem.config.shared" && blockStaleConfigDelete) {
                blockStaleConfigDelete = false;
                staleRollbackReachedDelete.resolve();
                await releaseStaleRollback.promise;
            }
            await originalDeleteValue(deleteCtx, key);
        };

        const firstCreation = outcomeOf(
            first.createWithId(ctx, "shared", {
                features: { identity: { generation: "first" } },
            }),
        );
        releaseFailure.resolve();
        await staleRollbackReachedDelete.promise;

        // A different owner removes the failed generation and claims the same ID for a genuine
        // successor while the old generation's unconditional rollback is still suspended.
        await successorOwner.delete(ctx, "shared");
        const successor = await successorOwner.createWithId(ctx, "shared", {
            features: { identity: { generation: "successor" } },
        });
        await successor.waitForIdle();
        releaseStaleRollback.resolve();
        const firstOutcome = await firstCreation;

        const durableConfig = await successorOwner.config(ctx, "shared");
        const restarted = collection(managerDisk, agentDisk, new ScriptedProvider([]));
        const restartedResolution = await outcomeOf(restarted.resolve(ctx, "shared"));
        if (restartedResolution.status === "fulfilled") {
            await restartedResolution.value.close();
        }
        await successor.close();

        expect({
            first: firstOutcome.status,
            durableConfig,
            restart: restartedResolution.status,
        }).toEqual({
            first: "rejected",
            durableConfig: {
                features: { identity: { generation: "successor" } },
            },
            restart: "fulfilled",
        });
    });

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
        let loads = 0;
        const loaded: AgentFeatureConstructor = class implements AgentFeature {
            readonly name = "loaded";

            load(): Promise<void> {
                loads += 1;
                return Promise.resolve();
            }
        };
        const provider = new ScriptedProvider([textTurn("recovered")]);
        const restarted = collection(managerDisk, agentDisk, provider, [loaded]);

        const starting = restarted.start(ctx);
        await configSnapshotStarted.promise;
        // The active-index snapshot is already empty. A previous process now commits the
        // consumed user record and disappears before it can publish another active span.
        agentDisk.records.push({ type: "user", message: user("answer after restart") });
        releaseConfigSnapshot.resolve();
        await starting;
        await flushMicrotasks();
        if (loads > 0) {
            const agent = await restarted.resolve(ctx, "shared");
            await agent.waitForIdle();
            await agent.close();
        }
        const questions = provider.sessions.flatMap((session) =>
            session.requests.flatMap((request) => askedIn(request.context.messages)),
        );

        expect({
            loads,
            questions,
        }).toEqual({
            loads: 1,
            questions: ["answer after restart"],
        });
    });

    it("serializes recovery probing with a live agent persistence operation", async () => {
        const managerDisk = new InMemoryPersistence();
        const agentDisk = new InMemoryPersistence();
        const provider = new ScriptedProvider([textTurn("live answer")]);
        const liveOwner = collection(managerDisk, agentDisk, provider);
        const live = await liveOwner.createWithId(ctx, "shared", {});
        await live.waitForIdle();

        const liveWriteStarted = deferred();
        const releaseLiveWrite = deferred();
        const originalWriteValue = agentDisk.writeValue.bind(agentDisk);
        const originalReadValues = agentDisk.readValues.bind(agentDisk);
        let liveOperationActive = false;
        let recoveryOverlappedLiveOperation = false;
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
        agentDisk.readValues = async (readCtx, prefix) => {
            if (prefix === "owed" && liveOperationActive) {
                recoveryOverlappedLiveOperation = true;
            }
            return await originalReadValues(readCtx, prefix);
        };

        const sending = liveOwner.send(ctx, "shared", user("live work"), { await: true });
        await liveWriteStarted.promise;
        const restarted = collection(managerDisk, agentDisk, new ScriptedProvider([]));
        const starting = outcomeOf(restarted.start(ctx));
        const earlyStart = await observedWithin(starting);
        releaseLiveWrite.resolve();
        await Promise.all([sending, starting]);
        await live.waitForIdle();
        await live.close();

        expect({
            recoveryOverlappedLiveOperation,
            startSettledWhileWriteBlocked: earlyStart.status === "settled",
        }).toEqual({
            recoveryOverlappedLiveOperation: false,
            startSettledWhileWriteBlocked: false,
        });
    });

    it("does not let a stale owner erase another owner's active marker", async () => {
        const managerDisk = new InMemoryPersistence();
        const agentDisk = new InMemoryPersistence();
        managerDisk.values.set("agentSystem.config.shared", {});
        const staleDeleteStarted = deferred();
        const releaseStaleDelete = deferred();
        const originalDeleteValue = managerDisk.deleteValue.bind(managerDisk);
        let blockFirstActiveDelete = true;
        managerDisk.deleteValue = async (deleteCtx, key) => {
            if (key === "agentSystem.active.shared" && blockFirstActiveDelete) {
                blockFirstActiveDelete = false;
                staleDeleteStarted.resolve();
                await releaseStaleDelete.promise;
            }
            await originalDeleteValue(deleteCtx, key);
        };

        const staleOwner = collection(managerDisk, agentDisk, new ScriptedProvider([]));
        const stale = await staleOwner.resolve(ctx, "shared");
        await staleDeleteStarted.promise;

        const inferenceStarted = deferred();
        const releaseInference = deferred();
        const blockInference: AgentFeatureConstructor = class implements AgentFeature {
            readonly name = "block-inference";

            async beforeInference(): Promise<void> {
                inferenceStarted.resolve();
                await releaseInference.promise;
            }
        };
        const writingProvider = new ScriptedProvider([textTurn("writer answer")]);
        const writingOwner = collection(managerDisk, agentDisk, writingProvider, [blockInference]);
        const writer = await writingOwner.resolve(ctx, "shared");
        await writer.waitForIdle();
        const sending = writingOwner.send(ctx, "shared", user("keep active"), { await: true });
        await inferenceStarted.promise;
        await sending;

        releaseStaleDelete.resolve();
        await stale.waitForIdle();
        const activeWhileWriterOwes = managerDisk.values.get("agentSystem.active.shared") === true;

        releaseInference.resolve();
        await writer.waitForIdle();
        await Promise.all([stale.close(), writer.close()]);

        expect(activeWhileWriterOwes).toBe(true);
    });

    it("settles sibling feature loads before a rejected creation can overlap its retry", async () => {
        const managerDisk = new InMemoryPersistence();
        const agentDisk = new InMemoryPersistence();
        const slowLoadStarted = deferred();
        const secondSlowLoadStarted = deferred();
        const releaseFirstSlowLoad = deferred();
        let failingLoads = 0;
        let slowLoads = 0;
        let activeSlowLoads = 0;
        let maximumActiveSlowLoads = 0;
        const failsOnce: AgentFeatureConstructor = class implements AgentFeature {
            readonly name = "fails-once";

            load(): Promise<void> {
                failingLoads += 1;
                return failingLoads === 1
                    ? Promise.reject(new Error("first feature rejected"))
                    : Promise.resolve();
            }
        };
        const slowSibling: AgentFeatureConstructor = class implements AgentFeature {
            readonly name = "slow-sibling";

            async load(): Promise<void> {
                slowLoads += 1;
                const attempt = slowLoads;
                activeSlowLoads += 1;
                maximumActiveSlowLoads = Math.max(maximumActiveSlowLoads, activeSlowLoads);
                if (attempt === 1) {
                    slowLoadStarted.resolve();
                    await releaseFirstSlowLoad.promise;
                } else {
                    secondSlowLoadStarted.resolve();
                }
                activeSlowLoads -= 1;
            }
        };
        const owner = collection(managerDisk, agentDisk, new ScriptedProvider([]), [
            failsOnce,
            slowSibling,
        ]);

        const firstCreation = outcomeOf(owner.createWithId(ctx, "shared", {}));
        await slowLoadStarted.promise;
        const earlyFailure = await observedWithin(firstCreation);
        if (earlyFailure.status === "pending") releaseFirstSlowLoad.resolve();
        await firstCreation;

        const retry = outcomeOf(owner.createWithId(ctx, "shared", {}));
        if (earlyFailure.status === "settled") {
            await secondSlowLoadStarted.promise;
            releaseFirstSlowLoad.resolve();
        }
        const retryOutcome = await retry;
        await flushMicrotasks();
        if (retryOutcome.status === "fulfilled") await retryOutcome.value.close();

        expect({
            maximumActiveSlowLoads,
            retry: retryOutcome.status,
        }).toEqual({
            maximumActiveSlowLoads: 1,
            retry: "fulfilled",
        });
    });

    it("does not deadlock when a feature load resolves another agent from its collection", async () => {
        const managerDisk = new InMemoryPersistence();
        const agentDisk = new InMemoryPersistence();
        managerDisk.values.set("agentSystem.config.dependency", {});
        const reentrantFeature: AgentFeatureConstructor = class implements AgentFeature {
            readonly name = "reentrant-load";
            readonly #agentId: string;

            constructor(agentId: string) {
                this.#agentId = agentId;
            }

            async load(loadCtx: Context): Promise<void> {
                if (this.#agentId !== "root") return;
                const owner = agentsFromContext(loadCtx);
                if (owner === undefined) throw new Error("missing collection");
                // Enter as an independent caller while `root` still owns the collection lock.
                // Passing the lock-bearing feature context would be rejected as direct reentry;
                // the ordinary caller context exposes the global lock wait this scenario guards.
                await owner.resolve(ctx, "dependency");
            }
        };
        const owner = collection(managerDisk, agentDisk, new ScriptedProvider([]), [
            reentrantFeature,
        ]);

        const creation = outcomeOf(owner.createWithId(ctx, "root", {}));
        const observed = await observedWithin(creation);
        if (observed.status === "settled" && observed.value.status === "fulfilled") {
            const dependency = await owner.resolve(ctx, "dependency");
            await Promise.all([observed.value.value.close(), dependency.close()]);
        }

        expect(observed.status === "settled" ? observed.value.status : "pending").toBe("fulfilled");
    });

    it("surfaces a rollback deletion failure and never leaves a ghost identity", async () => {
        const managerDisk = new InMemoryPersistence();
        const agentDisk = new InMemoryPersistence();
        const broken: AgentFeatureConstructor = class implements AgentFeature {
            readonly name = "broken";

            load(): Promise<void> {
                return Promise.reject(new Error("feature load failed"));
            }
        };
        const owner = collection(managerDisk, agentDisk, new ScriptedProvider([]), [broken]);
        const originalDeleteValue = managerDisk.deleteValue.bind(managerDisk);
        let failRollback = true;
        managerDisk.deleteValue = (deleteCtx, key) => {
            if (key === "agentSystem.config.ghost" && failRollback) {
                failRollback = false;
                return Promise.reject(new Error("rollback delete failed"));
            }
            return originalDeleteValue(deleteCtx, key);
        };

        const creation = await outcomeOf(owner.createWithId(ctx, "ghost", {}));
        const durableConfig = await owner.config(ctx, "ghost");
        const message =
            creation.status === "rejected" ? errorMessage(creation.reason) : "fulfilled";
        // Leave this isolated in-memory store clean even when the production rollback did not.
        managerDisk.values.delete("agentSystem.config.ghost");

        expect({
            durableConfig,
            message,
        }).toEqual({
            durableConfig: undefined,
            message: "rollback delete failed",
        });
    });

    it("linearizes deletion with another manager resolving the same identity", async () => {
        const managerDisk = new InMemoryPersistence();
        const agentDisk = new InMemoryPersistence();
        managerDisk.values.set("agentSystem.config.shared", {});
        const resolverLoadStarted = deferred();
        const releaseResolverLoad = deferred();
        const blockingFeature: AgentFeatureConstructor = class implements AgentFeature {
            readonly name = "blocking-load";

            async load(): Promise<void> {
                resolverLoadStarted.resolve();
                await releaseResolverLoad.promise;
            }
        };
        const resolvingOwner = collection(managerDisk, agentDisk, new ScriptedProvider([]), [
            blockingFeature,
        ]);
        const deletingOwner = collection(managerDisk, agentDisk, new ScriptedProvider([]));

        const resolution = outcomeOf(resolvingOwner.resolve(ctx, "shared"));
        await resolverLoadStarted.promise;
        await deletingOwner.delete(ctx, "shared");
        releaseResolverLoad.resolve();
        const resolutionOutcome = await resolution;

        const durableConfig = await resolvingOwner.config(ctx, "shared");
        const restarted = collection(managerDisk, agentDisk, new ScriptedProvider([]));
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

    it("recreates a deleted identity without its old conversation, settings, or feature KV", async () => {
        const managerDisk = new InMemoryPersistence();
        const agentDisk = new InMemoryPersistence();
        const provider = new ScriptedProvider([textTurn("old answer"), textTurn("new answer")]);
        const owner = collection(managerDisk, agentDisk, provider);

        const oldAgent = await owner.createWithId(ctx, "shared", {});
        await oldAgent.waitForIdle();
        await owner.send(ctx, "shared", user("old question"), { await: true, model: "old-model" });
        await oldAgent.waitForIdle();
        agentDisk.values.set("kv.shared.feature.state.legacy", "old value");
        await owner.delete(ctx, "shared");

        const recreated = await owner.createWithId(ctx, "shared", {});
        await recreated.waitForIdle();
        const recreatedKV = agentDisk.values.get("kv.shared.feature.state.legacy");
        await owner.send(ctx, "shared", user("new question"), { await: true });
        await recreated.waitForIdle();
        const requests = provider.sessions.flatMap((session) => session.requests);
        const latest = requests.at(-1);
        const latestQuestions = latest === undefined ? [] : askedIn(latest.context.messages);
        const latestModel = latest?.model;
        await recreated.close();

        expect({
            latestModel,
            latestQuestions,
            recreatedKV,
        }).toEqual({
            latestModel: undefined,
            latestQuestions: ["new question"],
            recreatedKV: undefined,
        });
    });

    it("copies nested creation config before caller mutation can diverge memory from storage", async () => {
        const managerDisk = new InMemoryPersistence();
        const agentDisk = new InMemoryPersistence();
        const loadStarted = deferred();
        const releaseLoad = deferred();
        let observedSetting: unknown;
        const recorder: AgentFeatureConstructor = class implements AgentFeature {
            readonly name = "recorder";

            async load(loadCtx: Context): Promise<void> {
                loadStarted.resolve();
                await releaseLoad.promise;
                observedSetting = agentFeatureConfig(loadCtx, "recorder")?.label;
            }
        };
        const owner = collection(managerDisk, agentDisk, new ScriptedProvider([]), [recorder]);
        const config: AgentConfig = {
            features: { recorder: { label: "original" } },
        };

        const creation = owner.createWithId(ctx, "shared", config);
        await loadStarted.promise;
        const callerSettings = config.features?.recorder;
        if (callerSettings !== undefined) callerSettings.label = "mutated by caller";
        releaseLoad.resolve();
        const agent = await creation;
        const durableConfig = await owner.config(ctx, "shared");
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
