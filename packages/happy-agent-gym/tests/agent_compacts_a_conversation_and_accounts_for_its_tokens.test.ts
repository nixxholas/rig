import { afterEach, describe, expect, it } from "vitest";

import {
    createAgentGym,
    GYM_MODEL_ID,
    GYM_PROVIDER_ID,
    type AgentGym,
    type GymCompactionHandler,
} from "../sources/index.js";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

const NO_TOKENS = { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, totalTokens: 0 } as const;

/** A compaction that replaces the whole conversation with one sentence of its own. */
function compactionSaying(summary: string): GymCompactionHandler {
    return (request) => ({
        context: {
            instructions: request.context.instructions,
            messages: [{ content: [{ text: summary, type: "text" }], role: "user" }],
        },
        preservedMessages: [],
        status: "completed",
        summary,
        usage: NO_TOKENS,
    });
}

interface ProtocolUsage {
    readonly currentProviderId: string;
    readonly groups: readonly {
        readonly kind: string;
        readonly modelId: string;
        readonly providerId: string;
        readonly requestedModelId: string;
        readonly usage: {
            readonly input: number;
            readonly output: number;
            readonly totalTokens: number;
        };
    }[];
    readonly sessionTokenCount: {
        readonly lastContextTokens: number;
        readonly totalTokens: number;
    };
}

describe("the agent compacts a conversation", () => {
    it("shows the compaction what was said and the next turn only the replacement", async () => {
        const gym = await createAgentGym({
            compaction: compactionSaying("Earlier: the passphrase is marigold."),
            inference: [
                { content: [{ text: "I will remember it.", type: "text" }] },
                { content: [{ text: "The passphrase is marigold.", type: "text" }] },
            ],
        });
        running.add(gym);

        await gym.send("Remember that the passphrase is marigold.");

        const compacted = await gym.http.post<{ readonly result: string }>(
            `/v0/sessions/${gym.defaultSessionId}/compact`,
            { await: true },
        );
        expect(compacted.status).toBe(200);
        expect(compacted.body.result).toBe("completed");

        // The compaction was asked to summarize exactly the conversation it supersedes, on the
        // model the chat is running on.
        expect(gym.inference.compactions).toHaveLength(1);
        const request = gym.inference.compactions[0];
        expect(request?.model).toBe(GYM_MODEL_ID);
        expect(JSON.stringify(request?.messages)).toContain(
            "Remember that the passphrase is marigold.",
        );
        expect(JSON.stringify(request?.messages)).toContain("I will remember it.");

        await gym.send("What was the passphrase?");

        // The next turn sees the replacement in place of everything it replaced.
        const shown = JSON.stringify(gym.inference.last?.messages);
        expect(shown).toContain("Earlier: the passphrase is marigold.");
        expect(shown).toContain("What was the passphrase?");
        expect(shown).not.toContain("Remember that the passphrase is marigold.");
        expect(shown).not.toContain("I will remember it.");

        expect(gym.inference.unscripted).toEqual([]);
        expect(gym.errors).toEqual([]);
    });
});

describe("the agent accounts for the tokens a turn cost", () => {
    it("reports the input and output the provider declared, attributed to its model", async () => {
        const gym = await createAgentGym({
            inference: [
                {
                    content: [{ text: "Counted.", type: "text" }],
                    usage: {
                        cacheRead: 64,
                        cacheWrite: 32,
                        input: 1200,
                        output: 340,
                        totalTokens: 1540,
                    },
                },
            ],
        });
        running.add(gym);

        await gym.send("Spend some tokens.");

        const usage = await gym.http.ok<ProtocolUsage>(
            "GET",
            `/v0/sessions/${gym.defaultSessionId}/usage`,
        );

        expect(usage.currentProviderId).toBe(GYM_PROVIDER_ID);
        expect(usage.sessionTokenCount.totalTokens).toBe(1540);
        expect(usage.groups.every((group) => group.providerId === GYM_PROVIDER_ID)).toBe(true);
        expect(usage.groups.every((group) => group.modelId === GYM_MODEL_ID)).toBe(true);

        const spent = usage.groups.filter((group) => group.usage.totalTokens > 0);
        expect(spent).toHaveLength(1);
        expect(spent[0]?.usage).toMatchObject({ input: 1200, output: 340, totalTokens: 1540 });
        expect(spent[0]?.requestedModelId).toBe(GYM_MODEL_ID);

        // The surviving context reports the real size the provider measured, and the
        // whole-installation snapshot reports the real per-provider tokens spent.
        expect(usage.sessionTokenCount.lastContextTokens).toBe(1540);
        const providerUsage = await gym.http.ok<{
            readonly providers: readonly {
                readonly checkedAt: number;
                readonly error: string | null;
                readonly providerId: string;
                readonly tokens: {
                    readonly inferences: number;
                    readonly input: number;
                    readonly output: number;
                    readonly total: number;
                    readonly turns: number;
                };
                readonly usage: unknown;
            }[];
        }>("GET", "/v0/provider-usage");
        expect(providerUsage.providers).toEqual([
            {
                checkedAt: expect.any(Number),
                error: null,
                providerId: GYM_PROVIDER_ID,
                tokens: { inferences: 1, input: 1200, output: 340, total: 1540, turns: 2 },
                usage: null,
            },
        ]);
        expect(gym.errors).toEqual([]);
    });

    it("keeps counting the tokens a turn cost after the conversation was compacted", async () => {
        const gym = await createAgentGym({
            compaction: compactionSaying("Earlier: two turns were spent."),
            inference: [
                {
                    content: [{ text: "First.", type: "text" }],
                    usage: { ...NO_TOKENS, input: 100, output: 10, totalTokens: 110 },
                },
                {
                    content: [{ text: "Second.", type: "text" }],
                    usage: { ...NO_TOKENS, input: 200, output: 20, totalTokens: 220 },
                },
            ],
        });
        running.add(gym);

        await gym.send("First turn.");
        await gym.compact();
        await gym.send("Second turn.");

        const usage = await gym.http.ok<ProtocolUsage>(
            "GET",
            `/v0/sessions/${gym.defaultSessionId}/usage`,
        );

        // Compaction erases the conversation, not the record of what it cost to have it.
        expect(usage.sessionTokenCount.totalTokens).toBe(330);
        const spent = usage.groups
            .filter((group) => group.usage.totalTokens > 0)
            .map((group) => group.usage.totalTokens);
        expect(spent.reduce((total, tokens) => total + tokens, 0)).toBe(330);
        expect(gym.inference.unscripted).toEqual([]);
        expect(gym.errors).toEqual([]);
    });
});
