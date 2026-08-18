import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
    AgentProviders,
    AgentStorage,
    withAgentDatabase,
    type AgentConfig,
    type AgentDatabase,
    type AgentMetadata,
    type AgentModel,
} from "@slopus/happy-agent-base";
import {
    ConfigModule,
    EventsModule,
    HistoryModule,
    TitlesModule,
    WorkspacesModule,
} from "@slopus/happy-agent-modules";
import {
    BaseProvider,
    BaseSession,
    type SessionCompaction,
    type SessionCompactionOptions,
    type SessionEvent,
    type SessionOptions,
    type SessionRunRequest,
    type SessionStream,
} from "@slopus/happy-providers";
import { createRootContext, type Context, type RootContext } from "@steve.kite/stdlib";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { afterEach, describe, expect, it } from "vitest";

import { ConversationModule } from "../../sources/modules/conversations/ConversationModule.js";

const AGENT_ID = "agent-under-test";

const closers: (() => void)[] = [];

afterEach(() => {
    for (const close of closers.splice(0)) close();
});

describe("a chat's second look at its own title", () => {
    it("renames the chat from the conversation once the first piece of work is over", async () => {
        const test = await harness(["<title>Retry policy rewrite</title>"]);
        await test.say("user", "this keeps failing when the network is slow");
        await test.say("assistant", "the outer loop retries a request it should not retry");

        await test.secondLook();

        expect(test.title).toBe("Retry policy rewrite");
        expect(await test.titleStatus()).toBe("ready");
        const sent = JSON.stringify(test.provider.sessions[0]?.requests[0]?.context.messages);
        expect(sent).toContain("User: this keeps failing when the network is slow");
        expect(sent).toContain("Assistant: the outer loop retries");
        // The title it already had is what the model is asked to keep.
        expect(sent).toContain("Flaky network");
    });

    it("looks again as soon as the person says something else, without waiting for the turn", async () => {
        const test = await harness(["<title>Retry policy rewrite</title>"]);
        await test.say("user", "this keeps failing");

        // The agent is still working and has written nothing back, which is exactly when someone
        // says what they actually meant. The message is handed over because the agent may not have
        // written it into history yet.
        await test.secondLook({ justSaid: "actually the whole retry policy is wrong, rewrite it" });

        expect(test.title).toBe("Retry policy rewrite");
        const sent = JSON.stringify(test.provider.sessions[0]?.requests[0]?.context.messages);
        expect(sent).toContain("User: this keeps failing");
        expect(sent).toContain("User: actually the whole retry policy is wrong");
    });

    it("carries a just-submitted message once, however that race came out", async () => {
        const test = await harness(["<title>Retry policy rewrite</title>"]);
        await test.say("user", "this keeps failing");
        await test.say("user", "actually rewrite the retry policy");

        await test.secondLook({ justSaid: "actually rewrite the retry policy" });

        const sent = String(
            JSON.stringify(test.provider.sessions[0]?.requests[0]?.context.messages),
        );
        expect(sent.split("actually rewrite the retry policy")).toHaveLength(2);
    });

    it("looks at a chat once, whichever trigger got there first", async () => {
        const test = await harness([
            "<title>Retry policy rewrite</title>",
            "<title>Something else entirely</title>",
        ]);
        await test.say("user", "this keeps failing");

        // The person writing again is the first trigger; the turn ending is the second.
        await test.secondLook({ justSaid: "and again" });
        await test.say("assistant", "the outer loop retries too eagerly");
        await test.secondLook();

        expect(test.title).toBe("Retry policy rewrite");
        expect(test.provider.sessions).toHaveLength(1);
    });

    it("leaves the title alone when the conversation has not contradicted it", async () => {
        const test = await harness(["<title>Flaky network</title>"]);
        await test.say("user", "this keeps failing");
        await test.say("assistant", "it does");

        await test.secondLook();

        expect(test.title).toBe("Flaky network");
        expect(test.updates).toBe(0);
    });

    it("tries again after an attempt that produced no name at all", async () => {
        const test = await harness(["<title>   </title>", "<title>Retry policy rewrite</title>"]);
        await test.say("user", "this keeps failing");
        await test.say("assistant", "the outer loop retries too eagerly");

        await test.secondLook();
        expect(test.title).toBe("Flaky network");

        await test.secondLook();
        expect(test.title).toBe("Retry policy rewrite");
    });

    it("asks nothing of a chat that has not said anything yet", async () => {
        const test = await harness(["<title>Retry policy rewrite</title>"]);

        await test.secondLook();

        expect(test.provider.sessions).toHaveLength(0);
        expect(test.title).toBe("Flaky network");
    });

    it("waits for something the message it was named after did not already say", async () => {
        const test = await harness(["<title>Retry policy rewrite</title>"]);
        await test.say("user", "this keeps failing");

        // One message and no answer is exactly what the title was drawn from. Asking again would
        // spend the chat's one second look re-reading the answer it already has.
        await test.secondLook();

        expect(test.provider.sessions).toHaveLength(0);
        await expect(test.titles.claimChatRefinement(test.ctx, test.sessionId)).resolves.toBe(true);
    });

    it("keeps a chat's title from being written by an account that is signed out", async () => {
        const test = await harness([]);
        test.provider.failure = "That account is signed out.";
        await test.say("user", "this keeps failing");
        await test.say("assistant", "the outer loop retries too eagerly");

        await test.secondLook();

        expect(test.title).toBe("Flaky network");
        // The attempt was inconclusive, so the one second look this chat gets is still owed to it.
        await expect(test.titles.claimChatRefinement(test.ctx, test.sessionId)).resolves.toBe(true);
    });
});

/** A real conversation catalog, a real history archive and a real titles module over one database. */
async function harness(answers: readonly string[]) {
    const sqlite = new DatabaseSync(":memory:");
    closers.push(() => sqlite.close());
    const database = drizzle(async (query, params, method) => {
        const statement = sqlite.prepare(query);
        if (method === "run") {
            statement.run(...params);
            return { rows: [] };
        }
        if (method === "get") {
            const row = statement.get(...params);
            return { rows: row === undefined ? [] : [row] };
        }
        if (method === "values") {
            statement.setReturnArrays(true);
            return { rows: statement.all(...params) };
        }
        return { rows: statement.all(...params) };
    }) as unknown as AgentDatabase;

    const rootContext = withAgentDatabase(createRootContext(), database) as RootContext;
    const ctx = rootContext.named("session-title-second-look");

    const provider = new ScriptedProvider(answers);
    const providers = new AgentProviders();
    providers.add("scripted", provider, "gym");

    // The accounts reach naming the way they reach it in the product: through the configuration
    // module, which owns them.
    const config = await ConfigModule.load(await mkdtemp(join(tmpdir(), "happy-second-look-")), {
        inference: {
            models: [
                {
                    providerId: "scripted",
                    id: "anthropic/sonnet-5",
                    name: "Sonnet 5",
                    effortLevels: ["off", "medium"],
                    defaultEffort: "medium",
                },
            ] as AgentModel[],
            providers,
        },
    });

    const events = new EventsModule();
    const history = new HistoryModule({});
    const titles = new TitlesModule({
        config,
        workspaces: new WorkspacesModule({ enabled: false }),
    });
    const conversations = new ConversationModule({
        defaultCwd: "/tmp",
        events,
        history,
        rootContext,
        titles,
    });

    // The chat is already named, the way a first message names it, so the second look has a title
    // to keep or replace rather than one to invent.
    let metadata: AgentMetadata = { title: "Flaky network" };
    let updates = 0;
    const agents = {
        config: (_ctx: Context, _agentId: string) => Promise.resolve({ metadata } as AgentConfig),
        updateMetadata: (_ctx: Context, _agentId: string, update: AgentMetadata) => {
            metadata = { ...metadata, ...update };
            updates += 1;
            return Promise.resolve();
        },
    } as never;

    // The same store a collection gives its modules, migrated the same way, so what titles
    // remembers between chats is written where it really is written.
    const storage = new AgentStorage({
        acquireLock: () => Promise.resolve({ release: () => Promise.resolve() }),
        database,
    });
    await storage.migrate(ctx, [conversations, history, titles]);
    for (const module of [conversations, titles]) {
        await module
            .beforeStart()
            .agentCreatedTransact?.(
                ctx,
                { agents, sharedKV: storage.kv.scoped("modules").scoped(module.name) },
                { id: AGENT_ID, metadata: undefined },
            );
    }

    const session = await conversations.getByAgent(ctx, AGENT_ID);
    if (session === undefined) throw new Error("The catalog did not record the chat.");

    return {
        ctx,
        provider,
        sessionId: session.id,
        titles,
        get title(): string | undefined {
            return metadata.title;
        },
        get updates(): number {
            return updates;
        },
        say: async (role: "assistant" | "user", text: string) => {
            await history.record(ctx, AGENT_ID, { blocks: [{ type: "text", text }], role });
        },
        /** Takes the second look the way a trigger takes it, and waits for it as nobody does. */
        secondLook: async (options: { readonly justSaid?: string } = {}) => {
            conversations.takeSecondLook(ctx, AGENT_ID, options);
            await conversations.whenTitlesSettle();
        },
        titleStatus: async () => (await conversations.getByAgent(ctx, AGENT_ID))?.titleStatus,
    };
}

/** A provider that answers each naming request with the next scripted title, or refuses outright. */
class ScriptedProvider extends BaseProvider {
    static override readonly name = "scripted";
    static override readonly inputTypes = ["text"] as const;
    static override readonly outputTypes = ["text"] as const;

    readonly sessions: ScriptedSession[] = [];
    failure: string | undefined;

    readonly #answers: string[];

    constructor(answers: readonly string[]) {
        super();
        this.#answers = [...answers];
    }

    session(id: string, options: SessionOptions): Promise<BaseSession> {
        const session = new ScriptedSession(id, this.#answers, options, () => this.failure);
        this.sessions.push(session);
        return Promise.resolve(session);
    }
}

class ScriptedSession extends BaseSession {
    readonly requests: SessionRunRequest[] = [];
    readonly options: SessionOptions;

    readonly #answers: string[];
    readonly #failure: () => string | undefined;

    constructor(
        id: string,
        answers: string[],
        options: SessionOptions,
        failure: () => string | undefined,
    ) {
        super(id);
        this.#answers = answers;
        this.#failure = failure;
        this.options = options;
    }

    run(_ctx: Context, request: SessionRunRequest): SessionStream {
        this.requests.push(request);
        const failure = this.#failure();
        const answer = this.#answers.shift() ?? "";
        return (async function* (): AsyncGenerator<SessionEvent> {
            if (failure !== undefined) {
                yield { type: "done", state: "error", kind: "unknown", message: failure };
                return;
            }
            yield { type: "text_start" };
            yield { type: "text_delta", delta: answer };
            yield { type: "text_end" };
            yield { type: "done", state: "normal", tokens: { input: 1, output: 1 } };
        })();
    }

    compact(_ctx: Context, _options: SessionCompactionOptions): Promise<SessionCompaction> {
        return Promise.reject(new Error("No scripted compaction result."));
    }

    destroy(): void {}
}
