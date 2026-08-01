import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { fetchClaudeProviderUsage } from "@/vendors/claude/fetchClaudeProviderUsage.js";
import { parseCodexProviderUsage } from "@/vendors/codex/fetchCodexProviderUsage.js";
import { fetchGrokProviderUsage } from "@/vendors/grok/fetchGrokProviderUsage.js";
import { GROK_OAUTH_SCOPE } from "@/vendors/grok/impl/auth.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("provider usage metadata", () => {
    it.each([
        {
            label: "workspace spend control",
            payload: {
                credits: { has_credits: true, unlimited: false },
                rate_limit: { allowed: true, limit_reached: false },
                spend_control: { reached: true },
            },
        },
        {
            label: "workspace credit depletion",
            payload: {
                credits: { has_credits: true, unlimited: false },
                rate_limit: { allowed: true, limit_reached: false },
                rate_limit_reached_type: { type: "workspace_member_credits_depleted" },
            },
        },
    ])("marks Codex exhausted for $label", ({ payload }) => {
        expect(
            parseCodexProviderUsage(payload, { capturedAt: 1_000, providerId: "codex" }).exhausted,
        ).toBe(true);
    });

    it("keeps valid Claude usage when the optional profile body is malformed", async () => {
        const usage = await fetchClaudeProviderUsage({
            oauthToken: "test-token",
            fetch: async (input) => {
                const path = new URL(String(input)).pathname;
                if (path === "/api/oauth/usage") {
                    return Response.json({ five_hour: { utilization: 42 } });
                }
                if (path === "/api/oauth/profile") {
                    return new Response("{", { status: 200 });
                }
                throw new Error(`Unexpected request ${path}`);
            },
        });

        expect(usage?.windows.fiveHour?.usedPercent).toBe(42);
    });

    it("keeps valid Grok billing when the optional user body is malformed", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-grok-usage-"));
        cleanups.push(() => rm(directory, { force: true, recursive: true }));
        const authFile = join(directory, "auth.json");
        await writeFile(
            authFile,
            JSON.stringify({
                [GROK_OAUTH_SCOPE]: {
                    expires_at: "2999-01-01T00:00:00.000Z",
                    key: "test-token",
                    user_id: "user-1",
                },
            }),
        );

        const usage = await fetchGrokProviderUsage({
            authFile,
            fetch: async (input) => {
                const path = new URL(String(input)).pathname;
                if (path === "/v1/billing") {
                    return Response.json({
                        config: {
                            creditUsagePercent: 37,
                            currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY" },
                        },
                    });
                }
                if (path === "/v1/user") {
                    return new Response("{", { status: 200 });
                }
                throw new Error(`Unexpected request ${path}`);
            },
        });

        expect(usage?.windows.monthly?.usedPercent).toBe(37);
    });
});
