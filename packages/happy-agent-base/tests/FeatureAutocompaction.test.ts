import type { SessionCompaction, SessionEvent, SessionMessage } from "@slopus/happy-providers";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { Agent, FeatureAutocompaction } from "../sources/index.js";
import { providersOf, user } from "./gym/fixtures.js";
import { InMemoryPersistence } from "./gym/InMemoryPersistence.js";
import { ScriptedProvider, ScriptedSession } from "./gym/ScriptedProvider.js";

const ctx = createRootContext().named("feature-autocompaction-test");

/**
 * Sonnet 5 compacts against a 333,000-token window; minus the 20,000-token output reserve and
 * the 13,000-token summary reserve, its threshold is 300,000.
 */
const MODEL = "anthropic/sonnet-5";

/** A complete scripted turn whose done event reports the given real context size. */
function reportedTurn(text: string, contextTokens: number): SessionEvent[] {
    return [
        { type: "text_start" },
        { type: "text_delta", delta: text },
        { type: "text_end" },
        { type: "done", state: "normal", tokens: { input: contextTokens - 10, output: 10 } },
    ];
}

/** A turn that fails, so the provider measures nothing for it. */
const failedTurn: SessionEvent[] = [
    { type: "done", state: "error", kind: "unknown", message: "provider exploded" },
];

const summary: SessionMessage = {
    role: "compaction",
    content: "summary of everything so far",
    encryptedContent: null,
};

const completed: SessionCompaction = {
    status: "completed",
    preservedMessages: [],
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
    context: { instructions: "", messages: [summary] },
};

/** Answer the compaction every session of this provider is asked for. */
function scriptCompaction(provider: ScriptedProvider, result: SessionCompaction): void {
    const create = provider.session.bind(provider);
    provider.session = async (id, options) => {
        const session = (await create(id, options)) as ScriptedSession;
        session.compactionResults = [result];
        return session;
    };
}

function agentWith(
    provider: ScriptedProvider,
    persistence: InMemoryPersistence,
    model = MODEL,
): Agent {
    return new Agent(ctx, {
        id: "test-agent",
        providers: providersOf(provider),
        provider: "scripted",
        persistence,
        model,
        features: [new FeatureAutocompaction()],
    });
}

function agentOf(provider: ScriptedProvider, model = MODEL): Agent {
    return agentWith(provider, new InMemoryPersistence(), model);
}

describe("FeatureAutocompaction", () => {
    it("compacts before the next turn once the measured context reaches the threshold", async () => {
        const provider = new ScriptedProvider([
            reportedTurn("big answer", 310_000),
            reportedTurn("later answer", 5_000),
        ]);
        scriptCompaction(provider, completed);
        const agent = agentOf(provider);

        // The oversized turn itself runs untouched — it is only measured.
        await agent.send(ctx, user("go"), { await: true });
        await agent.waitForIdle();
        const session = provider.sessions[0];
        expect(session?.compactions).toHaveLength(0);

        // The next turn compacts before its first inference, so that inference already runs on
        // the replaced context, and the measurement it produces stays under the threshold.
        await agent.send(ctx, user("more"), { await: true });
        await agent.waitForIdle();
        expect(session?.compactions).toHaveLength(1);
        expect(session?.requests[1]?.context.messages).toEqual([summary, user("more")]);

        // A third turn starts from the compacted, well-measured context and leaves it alone.
        await agent.send(ctx, user("even more"), { await: true });
        await agent.waitForIdle();
        expect(session?.compactions).toHaveLength(1);
        await agent.close();
    });

    it("leaves a context below the threshold alone", async () => {
        const provider = new ScriptedProvider([reportedTurn("answer", 100_000)]);
        const agent = agentOf(provider);

        await agent.send(ctx, user("go"), { await: true });
        await agent.waitForIdle();

        expect(provider.sessions[0]?.compactions).toHaveLength(0);
        await agent.close();
    });

    it("remembers the measured size across a restart", async () => {
        const persistence = new InMemoryPersistence();
        const first = new ScriptedProvider([reportedTurn("big answer", 310_000)]);
        const firstAgent = agentWith(first, persistence);
        await firstAgent.send(ctx, user("go"), { await: true });
        await firstAgent.waitForIdle();
        await firstAgent.close();
        expect(persistence.values.get("context")).toEqual({ tokens: 310_000 });

        // A fresh process reads the size back from storage, so its very first turn knows the
        // conversation is already too large.
        const second = new ScriptedProvider([reportedTurn("later answer", 5_000)]);
        scriptCompaction(second, completed);
        const secondAgent = agentWith(second, persistence);
        await secondAgent.send(ctx, user("more"), { await: true });
        await secondAgent.waitForIdle();

        expect(second.sessions[0]?.compactions).toHaveLength(1);
        expect(persistence.values.get("context")).toEqual({ tokens: 5_000 });
        await secondAgent.close();
    });

    it("does not compact again until the compacted context is measured too", async () => {
        const provider = new ScriptedProvider([reportedTurn("big answer", 310_000), failedTurn]);
        scriptCompaction(provider, completed);
        const agent = agentOf(provider);

        await agent.send(ctx, user("go"), { await: true });
        await agent.waitForIdle();
        // This turn compacts first, and its inference then fails without measuring anything.
        await agent.send(ctx, user("and more"), { await: true });
        await agent.waitForIdle();
        expect(provider.sessions[0]?.compactions).toHaveLength(1);

        // The replaced context has no measurement, so nothing compacts it a second time.
        await agent.send(ctx, user("again"), { await: true });
        await agent.waitForIdle();
        expect(provider.sessions[0]?.compactions).toHaveLength(1);
        await agent.close();
    });

    it("does not compact a turn that measured nothing", async () => {
        const provider = new ScriptedProvider([failedTurn]);
        const agent = agentOf(provider);

        await agent.send(ctx, user("go"), { await: true });
        await agent.waitForIdle();

        expect(provider.sessions[0]?.compactions).toHaveLength(0);
        await agent.close();
    });

    it("does not compact a cancelled turn, which measured nothing", async () => {
        const provider = new ScriptedProvider([reportedTurn("big answer", 310_000)]);
        scriptCompaction(provider, completed);
        const agent = agentOf(provider);

        await agent.send(ctx, user("go"), { await: true });
        await agent.abort(ctx, { await: true });
        await agent.waitForIdle();

        expect(provider.sessions[0]?.compactions ?? []).toHaveLength(0);
        await agent.close();
    });

    it("does nothing for a model absent from the catalog", async () => {
        const provider = new ScriptedProvider([reportedTurn("answer", 900_000)]);
        const agent = agentOf(provider, "mystery/model");

        await agent.send(ctx, user("go"), { await: true });
        await agent.waitForIdle();

        expect(provider.sessions[0]?.compactions).toHaveLength(0);
        await agent.close();
    });
});
