import { afterEach, describe, expect, it } from "vitest";

import { createAgentGym, GYM_PROVIDER_ID, type AgentGym } from "../sources/index.js";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

const NO_TOKENS = { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, totalTokens: 0 } as const;

interface ProviderUsageTokens {
    readonly inferences: number;
    readonly input: number;
    readonly output: number;
    readonly total: number;
    readonly turns: number;
}

interface ProviderUsage {
    readonly providers: readonly {
        readonly checkedAt: number;
        readonly error: string | null;
        readonly providerId: string;
        readonly tokens: ProviderUsageTokens;
        readonly usage: unknown;
    }[];
}

async function providerUsage(gym: AgentGym, providerId: string): Promise<ProviderUsageTokens> {
    const snapshot = await gym.http.ok<ProviderUsage>("GET", "/v0/provider-usage");
    const entry = snapshot.providers.find((candidate) => candidate.providerId === providerId);
    if (entry === undefined) {
        throw new Error(`Provider usage named no provider "${providerId}".`);
    }
    return entry.tokens;
}

describe("provider usage reports what the installation spent", () => {
    it("names every configured provider before a single turn has run", async () => {
        const gym = await createAgentGym();
        running.add(gym);

        const usage = await gym.http.ok<ProviderUsage>("GET", "/v0/provider-usage");

        expect(usage.providers.map((entry) => entry.providerId)).toEqual([GYM_PROVIDER_ID]);
        // Nothing has been asked of the model yet, so the provider is named with nothing spent.
        expect(usage.providers[0]?.tokens).toMatchObject({
            inferences: 0,
            input: 0,
            output: 0,
            total: 0,
        });
        // No vendor was asked for its plan and nothing failed, so the reading is absent rather
        // than an error.
        expect(usage.providers[0]?.error).toBeNull();
        expect(usage.providers[0]?.usage).toBeNull();
        expect(gym.errors).toEqual([]);
    });

    it("sums the tokens every chat spent on the provider that served them", async () => {
        const gym = await createAgentGym({
            inference: [
                {
                    content: [{ text: "Counted in the first chat.", type: "text" }],
                    usage: { ...NO_TOKENS, input: 1200, output: 340, totalTokens: 1540 },
                },
                {
                    content: [{ text: "Counted in the second chat.", type: "text" }],
                    usage: { ...NO_TOKENS, input: 200, output: 60, totalTokens: 260 },
                },
            ],
        });
        running.add(gym);

        const before = await providerUsage(gym, GYM_PROVIDER_ID);
        await gym.send("Spend some tokens.");
        const second = await gym.createSession({ cwd: gym.workspacePath });
        await gym.send("Spend some more.", { sessionId: second.id });

        const askedAt = Date.now();
        const snapshot = await gym.http.ok<ProviderUsage>("GET", "/v0/provider-usage");

        // Two chats spent their tokens on the one provider that served both, so the snapshot is
        // the sum rather than either chat's own share.
        expect(snapshot.providers).toHaveLength(1);
        const entry = snapshot.providers[0];
        expect(entry?.providerId).toBe(GYM_PROVIDER_ID);
        expect(entry?.tokens.input).toBe(before.input + 1400);
        expect(entry?.tokens.output).toBe(before.output + 400);
        expect(entry?.tokens.total).toBe(before.total + 1800);
        expect(entry?.tokens.inferences).toBe(before.inferences + 2);
        expect(entry?.tokens.turns).toBe(before.turns + 2);
        expect(entry?.checkedAt).toBeGreaterThanOrEqual(askedAt);

        // The per-chat view still answers for its own chat alone, which is the half of the same
        // measurement the installation-wide snapshot adds up.
        const session = await gym.http.ok<{
            readonly sessionTokenCount: { readonly totalTokens: number };
        }>("GET", `/v0/sessions/${gym.rootSessionId}/usage`);
        expect(session.sessionTokenCount.totalTokens).toBe(1540);

        expect(gym.inference.unscripted).toEqual([]);
        expect(gym.errors).toEqual([]);
    });
});
