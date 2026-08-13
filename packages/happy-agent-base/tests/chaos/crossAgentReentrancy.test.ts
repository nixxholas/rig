import {
    BaseProvider,
    BaseSession,
    type ProviderModality,
    type SessionCompaction,
    type SessionCompactionOptions,
    type SessionEvent,
    type SessionOptions,
    type SessionRunRequest,
    type SessionStream,
} from "@slopus/happy-providers";
import { Type } from "@sinclair/typebox";
import { asyncLock, createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    AgentBaseKV,
    AgentStorage,
    AgentSystemLocal,
    type AgentSystem,
    agentSystem,
    defineAgentTool,
    type AgentFeature,
    type AgentFeatureConstructor,
    type AnyAgentTool,
} from "../../sources/index.js";
import { InMemoryPersistence } from "../gym/InMemoryPersistence.js";
import { providersOf, system, textTurn, user } from "../gym/fixtures.js";

const ctx = createRootContext().named("happy-agent-base-cross-agent-reentrancy");

interface Deferred {
    readonly promise: Promise<void>;
    readonly resolve: () => void;
}

type ToolAction = (ctx: Context, owner: AgentSystem, agentId: string) => Promise<void>;

/** The collection under test, which exists only once the features it is built with do. */
interface OwnerHolder {
    owner?: AgentSystem;
}
type RunScript = readonly SessionEvent[] | ((ctx: Context) => SessionStream);

function deferred(): Deferred {
    let resolve!: () => void;
    const promise = new Promise<void>((settle) => {
        resolve = settle;
    });
    return { promise, resolve };
}

async function settlesWithin(work: Promise<unknown>, milliseconds = 100): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), milliseconds);
        void work.then(
            () => {
                clearTimeout(timer);
                resolve(true);
            },
            () => {
                clearTimeout(timer);
                resolve(true);
            },
        );
    });
}

function toolTurn(callId = "cross-call"): SessionEvent[] {
    return [
        { type: "toolcall_start", callId, name: "cross_agent" },
        { type: "toolcall_end", callId, arguments: "{}" },
        { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
    ];
}

function completedCompaction(text: string): SessionCompaction {
    return {
        status: "completed",
        preservedMessages: [],
        usage: {
            input: 10,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 12,
        },
        context: {
            instructions: "",
            messages: [system(text)],
        },
    };
}

function userTexts(persistence: InMemoryPersistence): string[] {
    return persistence.records.flatMap((record) =>
        record.type === "user"
            ? record.message.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
            : [],
    );
}

function toolResults(persistence: InMemoryPersistence): string[] {
    return persistence.records.flatMap((record) =>
        record.type === "tool" ? [record.message.callId] : [],
    );
}

class RoutedSession extends BaseSession {
    readonly requests: SessionRunRequest[] = [];
    readonly compactions: SessionCompactionOptions[] = [];
    destroyCalls = 0;

    readonly #scripts: RunScript[];
    readonly #compactionResults: SessionCompaction[];

    constructor(id: string, scripts: RunScript[], compactionResults: SessionCompaction[]) {
        super(id);
        this.#scripts = scripts;
        this.#compactionResults = compactionResults;
    }

    run(runCtx: Context, request: SessionRunRequest): SessionStream {
        this.requests.push(request);
        const script = this.#scripts.shift() ?? [];
        if (typeof script === "function") return script(runCtx);
        return (async function* () {
            yield* script;
        })();
    }

    compact(_compactCtx: Context, options: SessionCompactionOptions): Promise<SessionCompaction> {
        this.compactions.push(options);
        const result = this.#compactionResults.shift();
        return result === undefined
            ? Promise.reject(new Error(`No compaction scripted for agent "${this.id}".`))
            : Promise.resolve(result);
    }

    destroy(): void {
        this.destroyCalls += 1;
    }
}

class RoutedProvider extends BaseProvider {
    static override readonly name = "scripted";
    static override readonly inputTypes: readonly ProviderModality[] = ["text"];
    static override readonly outputTypes: readonly ProviderModality[] = ["text"];

    readonly sessions = new Map<string, RoutedSession>();
    readonly #scripts: Map<string, RunScript[]>;
    readonly #compactions: Map<string, SessionCompaction[]>;

    constructor(
        scripts: ReadonlyMap<string, readonly RunScript[]>,
        compactions: ReadonlyMap<string, readonly SessionCompaction[]> = new Map(),
    ) {
        super();
        this.#scripts = new Map([...scripts].map(([agentId, turns]) => [agentId, [...turns]]));
        this.#compactions = new Map(
            [...compactions].map(([agentId, results]) => [agentId, [...results]]),
        );
    }

    session(id: string, _options: SessionOptions): Promise<BaseSession> {
        const session = new RoutedSession(
            id,
            this.#scripts.get(id) ?? [],
            this.#compactions.get(id) ?? [],
        );
        this.sessions.set(id, session);
        return Promise.resolve(session);
    }
}

function crossAgentFeature(
    actions: ReadonlyMap<string, ToolAction>,
    holder: OwnerHolder,
): AgentFeatureConstructor {
    return class implements AgentFeature {
        readonly name = "cross-agent-reentrancy";
        readonly #agentId: string;
        readonly #tool: AnyAgentTool;

        constructor(agentId: string) {
            this.#agentId = agentId;
            this.#tool = defineAgentTool({
                name: "cross_agent",
                parameters: Type.Object({}),
                returnType: Type.Object({}),
                durable: false,
                shouldReviewInAutoMode: () => false,
                execute: async (toolCtx) => {
                    const action = actions.get(this.#agentId);
                    if (action === undefined) {
                        throw new Error(`No cross-agent action for "${this.#agentId}".`);
                    }
                    // These scenarios are about the owner's surface being used from inside a
                    // tool, so they reach for the collection itself rather than the reference a
                    // context carries.
                    const owner = holder.owner;
                    if (owner === undefined) throw new Error("The collection is not built yet.");
                    await action(toolCtx, owner, this.#agentId);
                    return {};
                },
                toLLM: () => [{ type: "text", text: "Cross-agent operation completed." }],
            });
        }

        readonly tools = (): readonly AnyAgentTool[] => [this.#tool];

        load(loadCtx: Context): Promise<void> {
            // A feature is given the collection as a reference, and nothing more.
            if (agentSystem(loadCtx) === undefined) {
                throw new Error("Cross-agent feature requires its owning collection.");
            }
            return Promise.resolve();
        }
    };
}

function managerKV(persistence: InMemoryPersistence): AgentBaseKV {
    const lock = asyncLock({ reentry: "block" });
    return new AgentBaseKV(persistence, "agentSystem.", async (operationCtx, work) =>
        lock.runInLock(operationCtx, work),
    );
}

function harness(
    actions: ReadonlyMap<string, ToolAction>,
    scripts: ReadonlyMap<string, readonly RunScript[]>,
    compactions: ReadonlyMap<string, readonly SessionCompaction[]> = new Map(),
): {
    readonly owner: AgentSystemLocal;
    readonly provider: RoutedProvider;
    readonly manager: InMemoryPersistence;
    readonly persistence: (agentId: string) => InMemoryPersistence;
} {
    const manager = new InMemoryPersistence();
    const persistences = new Map<string, InMemoryPersistence>();
    const persistence = (agentId: string): InMemoryPersistence => {
        const existing = persistences.get(agentId);
        if (existing !== undefined) return existing;
        const created = new InMemoryPersistence();
        persistences.set(agentId, created);
        return created;
    };
    const provider = new RoutedProvider(scripts, compactions);
    const holder: OwnerHolder = {};
    const owner = new AgentSystemLocal({
        features: [crossAgentFeature(actions, holder)],
        storage: new AgentStorage({
            kv: managerKV(manager),
            persistence,
        }),
        providers: providersOf(provider),
        provider: "scripted",
        models: [],
    });
    holder.owner = owner;
    return { owner, provider, manager, persistence };
}

/**
 * A tool is part of one agent's turn but may use the collection to reach another agent. These
 * scenarios exercise the resulting lock graph at the public boundary: messages are durably
 * admitted exactly once, recursive calls settle, and operations that wait for the target's
 * lifetime do not accidentally turn two independent agentSystem into one global lock.
 */
describe("cross-agent tool re-entrancy", () => {
    it("lets agent A's tool await a durable send to agent B", async () => {
        let executions = 0;
        const world = harness(
            new Map([
                [
                    "A",
                    async (toolCtx, owner) => {
                        executions += 1;
                        await owner.send(toolCtx, "B", user("message from A's tool"));
                    },
                ],
            ]),
            new Map([
                ["A", [toolTurn(), textTurn("A finished")]],
                ["B", [textTurn("B answered")]],
            ]),
        );
        const a = await world.owner.createWithId(ctx, "A", {});
        const b = await world.owner.createWithId(ctx, "B", {});

        await a.send(ctx, user("start A"), { await: true });
        await Promise.all([a.waitForIdle(), b.waitForIdle()]);
        const observed = {
            executions,
            bUsers: userTexts(world.persistence("B")),
            aToolResults: toolResults(world.persistence("A")),
            aRuns: world.provider.sessions.get("A")?.requests.length,
            bRuns: world.provider.sessions.get("B")?.requests.length,
        };
        await Promise.all([a.close(), b.close()]);

        expect(observed).toEqual({
            executions: 1,
            bUsers: ["message from A's tool"],
            aToolResults: ["cross-call"],
            aRuns: 2,
            bRuns: 1,
        });
    });

    it("lets agent A's tool await priority steering to agent B", async () => {
        const world = harness(
            new Map([
                [
                    "A",
                    async (toolCtx, owner) => {
                        await owner.steer(toolCtx, "B", user("steering from A's tool"));
                    },
                ],
            ]),
            new Map([
                ["A", [toolTurn(), textTurn("A finished")]],
                ["B", [textTurn("B handled steering")]],
            ]),
        );
        const a = await world.owner.createWithId(ctx, "A", {});
        const b = await world.owner.createWithId(ctx, "B", {});

        await a.send(ctx, user("start A"), { await: true });
        await Promise.all([a.waitForIdle(), b.waitForIdle()]);
        const observed = {
            bUsers: userTexts(world.persistence("B")),
            aToolResults: toolResults(world.persistence("A")),
            bRuns: world.provider.sessions.get("B")?.requests.length,
        };
        await Promise.all([a.close(), b.close()]);

        expect(observed).toEqual({
            bUsers: ["steering from A's tool"],
            aToolResults: ["cross-call"],
            bRuns: 1,
        });
    });

    it("lets agent A's tool compact an idle agent B without corrupting either history", async () => {
        const world = harness(
            new Map([
                [
                    "A",
                    async (toolCtx, owner) => {
                        await owner.compact(toolCtx, "B", { await: true });
                    },
                ],
            ]),
            new Map([
                ["A", [toolTurn(), textTurn("A finished after B compacted")]],
                ["B", [textTurn("B's old answer")]],
            ]),
            new Map([["B", [completedCompaction("summary of B only")]]]),
        );
        const a = await world.owner.createWithId(ctx, "A", {});
        const b = await world.owner.createWithId(ctx, "B", {});
        await b.send(ctx, user("seed B history"), { await: true });
        await b.waitForIdle();

        await a.send(ctx, user("compact B"), { await: true });
        await Promise.all([a.waitForIdle(), b.waitForIdle()]);
        const observed = {
            bRecordTypes: world.persistence("B").records.map((record) => record.type),
            bUsers: userTexts(world.persistence("B")),
            aUsers: userTexts(world.persistence("A")),
            aToolResults: toolResults(world.persistence("A")),
            bCompactions: world.provider.sessions.get("B")?.compactions.length,
        };
        await Promise.all([a.close(), b.close()]);

        expect(observed).toEqual({
            bRecordTypes: ["compaction"],
            bUsers: [],
            aUsers: ["compact B"],
            aToolResults: ["cross-call"],
            bCompactions: 1,
        });
    });

    it("settles a cycle where B's tool sends back to A while A awaits its send to B", async () => {
        const executions: string[] = [];
        const world = harness(
            new Map([
                [
                    "A",
                    async (toolCtx, owner) => {
                        executions.push("A");
                        await owner.send(toolCtx, "B", user("A asks B"));
                    },
                ],
                [
                    "B",
                    async (toolCtx, owner) => {
                        executions.push("B");
                        await owner.send(toolCtx, "A", user("B replies to A"));
                    },
                ],
            ]),
            new Map([
                [
                    "A",
                    [
                        toolTurn("A-to-B"),
                        textTurn("A closed its tool call"),
                        textTurn("A answered B's reply"),
                    ],
                ],
                ["B", [toolTurn("B-to-A"), textTurn("B closed its tool call")]],
            ]),
        );
        const a = await world.owner.createWithId(ctx, "A", {});
        const b = await world.owner.createWithId(ctx, "B", {});

        await a.send(ctx, user("start cycle"), { await: true });
        const settled = await settlesWithin(Promise.all([a.waitForIdle(), b.waitForIdle()]), 500);
        const observed = {
            settled,
            executions,
            aUsers: userTexts(world.persistence("A")),
            bUsers: userTexts(world.persistence("B")),
            aToolResults: toolResults(world.persistence("A")),
            bToolResults: toolResults(world.persistence("B")),
            aRuns: world.provider.sessions.get("A")?.requests.length,
            bRuns: world.provider.sessions.get("B")?.requests.length,
        };
        await Promise.all([a.close(), b.close()]);

        expect(observed).toEqual({
            settled: true,
            executions: ["A", "B"],
            aUsers: ["start cycle", "B replies to A"],
            bUsers: ["A asks B"],
            aToolResults: ["A-to-B"],
            bToolResults: ["B-to-A"],
            aRuns: 3,
            bRuns: 2,
        });
    });

    it("settles when two active agentSystem tool-call each other concurrently", async () => {
        const bothToolsStarted = deferred();
        let started = 0;
        const cross = (target: string, text: string): ToolAction => {
            return async (toolCtx, owner) => {
                started += 1;
                if (started === 2) bothToolsStarted.resolve();
                await bothToolsStarted.promise;
                await owner.send(toolCtx, target, user(text));
            };
        };
        const world = harness(
            new Map([
                ["A", cross("B", "concurrent message from A")],
                ["B", cross("A", "concurrent message from B")],
            ]),
            new Map([
                ["A", [toolTurn("A-cross"), textTurn("A tool settled"), textTurn("A answered B")]],
                ["B", [toolTurn("B-cross"), textTurn("B tool settled"), textTurn("B answered A")]],
            ]),
        );
        const a = await world.owner.createWithId(ctx, "A", {});
        const b = await world.owner.createWithId(ctx, "B", {});

        await Promise.all([
            a.send(ctx, user("start A"), { await: true }),
            b.send(ctx, user("start B"), { await: true }),
        ]);
        const settled = await settlesWithin(Promise.all([a.waitForIdle(), b.waitForIdle()]), 500);
        const observed = {
            settled,
            aUsers: userTexts(world.persistence("A")),
            bUsers: userTexts(world.persistence("B")),
            aToolResults: toolResults(world.persistence("A")),
            bToolResults: toolResults(world.persistence("B")),
            aRuns: world.provider.sessions.get("A")?.requests.length,
            bRuns: world.provider.sessions.get("B")?.requests.length,
        };
        await Promise.all([a.close(), b.close()]);

        expect(observed).toEqual({
            settled: true,
            aUsers: ["start A", "concurrent message from B"],
            bUsers: ["start B", "concurrent message from A"],
            aToolResults: ["A-cross"],
            bToolResults: ["B-cross"],
            aRuns: 3,
            bRuns: 3,
        });
    });

    it("rejects or schedules mutual cross-agent compaction instead of deadlocking both tools", async () => {
        const bothToolsStarted = deferred();
        let started = 0;
        const compactPeer = (target: string): ToolAction => {
            return async (toolCtx, owner) => {
                started += 1;
                if (started === 2) bothToolsStarted.resolve();
                await bothToolsStarted.promise;
                await owner.compact(toolCtx, target, { await: true });
            };
        };
        const world = harness(
            new Map([
                ["A", compactPeer("B")],
                ["B", compactPeer("A")],
            ]),
            new Map([
                ["A", [toolTurn("A-compacts-B"), textTurn("A continued")]],
                ["B", [toolTurn("B-compacts-A"), textTurn("B continued")]],
            ]),
            new Map([
                ["A", [completedCompaction("A summary")]],
                ["B", [completedCompaction("B summary")]],
            ]),
        );
        const a = await world.owner.createWithId(ctx, "A", {});
        const b = await world.owner.createWithId(ctx, "B", {});

        await Promise.all([
            a.send(ctx, user("start A"), { await: true }),
            b.send(ctx, user("start B"), { await: true }),
        ]);
        await bothToolsStarted.promise;
        const settledWithoutIntervention = await settlesWithin(
            Promise.all([a.waitForIdle(), b.waitForIdle()]),
        );
        await Promise.all([a.abort(ctx, { await: true }), b.abort(ctx, { await: true })]);
        await Promise.all([a.waitForIdle(), b.waitForIdle()]);
        const observed = {
            settledWithoutIntervention,
            aPending: [...world.persistence("A").pending.keys()],
            bPending: [...world.persistence("B").pending.keys()],
            aToolResults: toolResults(world.persistence("A")),
            bToolResults: toolResults(world.persistence("B")),
        };
        await Promise.all([a.close(), b.close()]);

        expect(observed).toEqual({
            settledWithoutIntervention: true,
            aPending: [],
            bPending: [],
            aToolResults: ["A-compacts-B"],
            bToolResults: ["B-compacts-A"],
        });
    });

    it("does not deadlock when two active tools close each other's agentSystem", async () => {
        const bothToolsStarted = deferred();
        let started = 0;
        const closePeer = (target: string): ToolAction => {
            return async (_toolCtx, owner) => {
                started += 1;
                if (started === 2) bothToolsStarted.resolve();
                await bothToolsStarted.promise;
                await (await owner.resolve(ctx, target)).close();
            };
        };
        const world = harness(
            new Map([
                ["A", closePeer("B")],
                ["B", closePeer("A")],
            ]),
            new Map([
                ["A", [toolTurn("A-closes-B"), textTurn("A continued")]],
                ["B", [toolTurn("B-closes-A"), textTurn("B continued")]],
            ]),
        );
        const a = await world.owner.createWithId(ctx, "A", {});
        const b = await world.owner.createWithId(ctx, "B", {});

        await Promise.all([
            a.send(ctx, user("start A"), { await: true }),
            b.send(ctx, user("start B"), { await: true }),
        ]);
        await bothToolsStarted.promise;
        const settledWithoutIntervention = await settlesWithin(
            Promise.all([a.waitForIdle(), b.waitForIdle()]),
        );
        await Promise.all([a.abort(ctx, { await: true }), b.abort(ctx, { await: true })]);
        await Promise.all([a.close(), b.close()]);
        const observed = {
            settledWithoutIntervention,
            aPending: [...world.persistence("A").pending.keys()],
            bPending: [...world.persistence("B").pending.keys()],
            aDestroyCalls: world.provider.sessions.get("A")?.destroyCalls,
            bDestroyCalls: world.provider.sessions.get("B")?.destroyCalls,
        };

        expect(observed).toEqual({
            settledWithoutIntervention: true,
            aPending: [],
            bPending: [],
            aDestroyCalls: 1,
            bDestroyCalls: 1,
        });
    });

    it("does not deadlock when two active tools delete each other's agentSystem", async () => {
        const bothToolsStarted = deferred();
        let started = 0;
        const deletePeer = (target: string): ToolAction => {
            return async (toolCtx, owner) => {
                started += 1;
                if (started === 2) bothToolsStarted.resolve();
                await bothToolsStarted.promise;
                await owner.delete(toolCtx, target);
            };
        };
        const world = harness(
            new Map([
                ["A", deletePeer("B")],
                ["B", deletePeer("A")],
            ]),
            new Map([
                ["A", [toolTurn("A-deletes-B"), textTurn("A continued")]],
                ["B", [toolTurn("B-deletes-A"), textTurn("B continued")]],
            ]),
        );
        const a = await world.owner.createWithId(ctx, "A", {});
        const b = await world.owner.createWithId(ctx, "B", {});

        await Promise.all([
            a.send(ctx, user("start A"), { await: true }),
            b.send(ctx, user("start B"), { await: true }),
        ]);
        await bothToolsStarted.promise;
        const settledWithoutIntervention = await settlesWithin(
            Promise.all([a.waitForIdle(), b.waitForIdle()]),
        );
        await Promise.all([a.abort(ctx, { await: true }), b.abort(ctx, { await: true })]);
        await Promise.all([a.close(), b.close()]);
        const observed = {
            settledWithoutIntervention,
            aConfig: await world.owner.config(ctx, "A"),
            bConfig: await world.owner.config(ctx, "B"),
            aPending: [...world.persistence("A").pending.keys()],
            bPending: [...world.persistence("B").pending.keys()],
        };

        expect(observed).toEqual({
            settledWithoutIntervention: true,
            aConfig: undefined,
            bConfig: undefined,
            aPending: [],
            bPending: [],
        });
    });

    it("lets agent A's tool abort active agent B without waiting for B's blocked stream", async () => {
        const bStarted = deferred();
        const releaseB = deferred();
        const abortStarted = deferred();
        const world = harness(
            new Map([
                [
                    "A",
                    async (toolCtx, owner) => {
                        abortStarted.resolve();
                        await owner.abort(toolCtx, "B", { await: true });
                    },
                ],
            ]),
            new Map([
                ["A", [toolTurn(), textTurn("A finished aborting B")]],
                [
                    "B",
                    [
                        () =>
                            (async function* () {
                                bStarted.resolve();
                                yield { type: "text_start" };
                                await releaseB.promise;
                                yield { type: "text_delta", delta: "late B text" };
                                yield { type: "text_end" };
                                yield {
                                    type: "done",
                                    state: "normal",
                                    tokens: { input: 1, output: 1 },
                                };
                            })(),
                    ],
                ],
            ]),
        );
        const a = await world.owner.createWithId(ctx, "A", {});
        const b = await world.owner.createWithId(ctx, "B", {});
        await b.send(ctx, user("block B"), { await: true });
        await bStarted.promise;

        await a.send(ctx, user("abort B"), { await: true });
        await abortStarted.promise;
        const aSettledWhileBBlocked = await settlesWithin(a.waitForIdle());
        releaseB.resolve();
        await Promise.all([a.waitForIdle(), b.waitForIdle()]);
        const observed = {
            aSettledWhileBBlocked,
            aToolResults: toolResults(world.persistence("A")),
            bBlocks: world.persistence("B").records.filter((record) => record.type === "block")
                .length,
        };
        await Promise.all([a.close(), b.close()]);

        expect(observed).toEqual({
            aSettledWhileBBlocked: true,
            aToolResults: ["cross-call"],
            bBlocks: 0,
        });
    });

    it("lets agent A's tool close active agent B once B's admitted work settles", async () => {
        const bStarted = deferred();
        const releaseB = deferred();
        const closeStarted = deferred();
        const world = harness(
            new Map([
                [
                    "A",
                    async (_toolCtx, owner) => {
                        closeStarted.resolve();
                        await (await owner.resolve(ctx, "B")).close();
                    },
                ],
            ]),
            new Map([
                ["A", [toolTurn(), textTurn("A finished closing B")]],
                [
                    "B",
                    [
                        () =>
                            (async function* () {
                                bStarted.resolve();
                                yield { type: "text_start" };
                                await releaseB.promise;
                                yield { type: "text_delta", delta: "B finished before close" };
                                yield { type: "text_end" };
                                yield {
                                    type: "done",
                                    state: "normal",
                                    tokens: { input: 1, output: 1 },
                                };
                            })(),
                    ],
                ],
            ]),
        );
        const a = await world.owner.createWithId(ctx, "A", {});
        const b = await world.owner.createWithId(ctx, "B", {});
        await b.send(ctx, user("finish B before close"), { await: true });
        await bStarted.promise;

        await a.send(ctx, user("close B"), { await: true });
        await closeStarted.promise;
        const closedBeforeRelease = await settlesWithin(a.waitForIdle(), 40);
        releaseB.resolve();
        const settledAfterRelease = await settlesWithin(a.waitForIdle(), 500);
        const observed = {
            closedBeforeRelease,
            settledAfterRelease,
            bRecordTypes: world.persistence("B").records.map((record) => record.type),
            aToolResults: toolResults(world.persistence("A")),
            bDestroyCalls: world.provider.sessions.get("B")?.destroyCalls,
        };
        await Promise.all([a.close(), b.close()]);

        expect(observed).toEqual({
            closedBeforeRelease: false,
            settledAfterRelease: true,
            bRecordTypes: ["user", "block"],
            aToolResults: ["cross-call"],
            bDestroyCalls: 1,
        });
    });

    it("lets agent A's tool delete active agent B atomically after B settles", async () => {
        const bStarted = deferred();
        const releaseB = deferred();
        const deleteStarted = deferred();
        const world = harness(
            new Map([
                [
                    "A",
                    async (toolCtx, owner) => {
                        deleteStarted.resolve();
                        await owner.delete(toolCtx, "B");
                    },
                ],
            ]),
            new Map([
                ["A", [toolTurn(), textTurn("A finished deleting B")]],
                [
                    "B",
                    [
                        () =>
                            (async function* () {
                                bStarted.resolve();
                                yield { type: "text_start" };
                                await releaseB.promise;
                                yield { type: "text_delta", delta: "B committed before deletion" };
                                yield { type: "text_end" };
                                yield {
                                    type: "done",
                                    state: "normal",
                                    tokens: { input: 1, output: 1 },
                                };
                            })(),
                    ],
                ],
            ]),
        );
        const a = await world.owner.createWithId(ctx, "A", {});
        const b = await world.owner.createWithId(ctx, "B", {});
        await b.send(ctx, user("finish before deletion"), { await: true });
        await bStarted.promise;

        await a.send(ctx, user("delete B"), { await: true });
        await deleteStarted.promise;
        const deletedBeforeRelease = await settlesWithin(a.waitForIdle(), 40);
        releaseB.resolve();
        const settledAfterRelease = await settlesWithin(a.waitForIdle(), 500);
        const observed = {
            deletedBeforeRelease,
            settledAfterRelease,
            durableConfig: await world.owner.config(ctx, "B"),
            bRecordTypes: world.persistence("B").records.map((record) => record.type),
            aToolResults: toolResults(world.persistence("A")),
        };
        await Promise.all([a.close(), b.close()]);

        expect(observed).toEqual({
            deletedBeforeRelease: false,
            settledAfterRelease: true,
            durableConfig: undefined,
            bRecordTypes: ["user", "block"],
            aToolResults: ["cross-call"],
        });
    });
});
