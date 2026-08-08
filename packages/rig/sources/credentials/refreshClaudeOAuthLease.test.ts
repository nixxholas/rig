import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { refreshClaudeOAuthLease } from "./refreshClaudeOAuthLease.js";

describe("refreshClaudeOAuthLease", () => {
    const directories: string[] = [];

    afterEach(async () => {
        await Promise.all(
            directories.splice(0).map((directory) => rm(directory, { recursive: true })),
        );
    });

    it("refreshes expiring native credentials on their owner and returns only the access lease", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-claude-lease-"));
        directories.push(directory);
        const path = join(directory, ".credentials.json");
        await writeFile(
            path,
            JSON.stringify({
                claudeAiOauth: {
                    accessToken: "old-access",
                    expiresAt: 1_000,
                    refreshToken: "owner-refresh",
                    subscriptionType: "max",
                },
                unrelated: { preserved: true },
            }),
        );
        const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
            expect(JSON.parse(String(init?.body))).toMatchObject({
                client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
                grant_type: "refresh_token",
                refresh_token: "owner-refresh",
            });
            return new Response(
                JSON.stringify({
                    access_token: "new-access",
                    expires_in: 3_600,
                    refresh_token: "rotated-owner-refresh",
                }),
                { headers: { "content-type": "application/json" }, status: 200 },
            );
        });

        await expect(
            refreshClaudeOAuthLease({
                configDirectory: directory,
                env: {},
                fetch,
                now: () => 10_000,
                platform: "linux",
            }),
        ).resolves.toBe("new-access");
        expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
            claudeAiOauth: {
                accessToken: "new-access",
                expiresAt: 3_610_000,
                refreshToken: "rotated-owner-refresh",
                subscriptionType: "max",
            },
            unrelated: { preserved: true },
        });
    });

    it("does not call the token endpoint while the owner's lease remains current", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-claude-lease-"));
        directories.push(directory);
        await writeFile(
            join(directory, ".credentials.json"),
            JSON.stringify({
                claudeAiOauth: {
                    accessToken: "current-access",
                    expiresAt: 1_000_000,
                    refreshToken: "owner-refresh",
                },
            }),
        );
        const fetch = vi.fn();

        await expect(
            refreshClaudeOAuthLease({
                configDirectory: directory,
                env: {},
                fetch,
                now: () => 10_000,
                platform: "linux",
            }),
        ).resolves.toBe("current-access");
        expect(fetch).not.toHaveBeenCalled();
    });
});
