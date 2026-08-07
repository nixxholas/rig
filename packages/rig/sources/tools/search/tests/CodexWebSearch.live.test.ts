import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { modelOpenaiGpt56Sol } from "@slopus/rig-execution";

import { codexExecution } from "../../../executor/codexExecution.js";
import { createCodexWebSearchTool } from "../CodexWebSearch.js";

const LIVE = process.env.RIG_LIVE_TEST === "1";
const CODEX_AUTH_PATH = path.join(homedir(), ".codex", "auth.json");

const describeLive = LIVE && hasLocalCodexAuth() ? describe : describe.skip;

describeLive("codex_web_search live", () => {
    it(
        "runs native Codex web search through one bounded provider inference",
        { timeout: 90_000 },
        async () => {
            const provider = codexExecution({
                config: { enabled: true, type: "codex" },
                env: process.env,
                id: "codex",
                resolveInferenceMaxRetries: () => 0,
                sessionId: `codex-search-live-${Date.now()}`,
            });
            const profile = provider.profiles.find(
                (candidate) => candidate.id === modelOpenaiGpt56Sol.id,
            );
            if (profile === undefined) throw new Error("The Codex Sol profile is unavailable.");
            const tool = createCodexWebSearchTool({
                currentProviderId: provider.id,
                routes: [{ profile, provider }],
            });

            const result = await tool.execute(
                {
                    query: "Search the web for the current Node.js LTS release and cite an official nodejs.org page.",
                },
                {} as never,
                { signal: AbortSignal.timeout(30_000) },
            );

            expect(result.answer.trim().length).toBeGreaterThan(0);
            expect(result.citations.length).toBeGreaterThan(0);
            expect(result.citations.some((citation) => citation.href.includes("nodejs.org"))).toBe(
                true,
            );
            expect(result.durationMs).toBeLessThan(60_000);
        },
    );
});

describe.skipIf(!LIVE || hasLocalCodexAuth())("codex_web_search live prerequisites", () => {
    it("documents how to run the live test", () => {
        if (LIVE) {
            expect.fail(
                "RIG_LIVE_TEST=1 is set but ~/.codex/auth.json is missing a usable access_token",
            );
        }
    });
});

function hasLocalCodexAuth(): boolean {
    if (!existsSync(CODEX_AUTH_PATH)) return false;
    try {
        const data = JSON.parse(readFileSync(CODEX_AUTH_PATH, "utf8")) as {
            tokens?: { access_token?: unknown };
        };
        return (
            typeof data.tokens?.access_token === "string" &&
            data.tokens.access_token.trim().length > 0
        );
    } catch {
        return false;
    }
}
