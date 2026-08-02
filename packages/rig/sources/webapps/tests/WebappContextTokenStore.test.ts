import { describe, expect, it } from "vitest";

import { WebappContextTokenStore } from "../WebappContextTokenStore.js";

describe("WebappContextTokenStore", () => {
    it("mints opaque one-time tokens, expires them, and evicts the oldest token at the cap", () => {
        let now = 1_000;
        let sequence = 0;
        const tokens = new WebappContextTokenStore({
            cap: 2,
            now: () => now,
            randomToken: () => `opaque-${String(++sequence)}`,
            ttlMs: 100,
        });
        const first = tokens.mint({ version: 1, webapp: "dashboard" });
        const second = tokens.mint({ projectId: "project-1", version: 1, webapp: "dashboard" });
        const third = tokens.mint({ sessionId: "session-1", version: 1, webapp: "dashboard" });

        expect(first).not.toContain("dashboard");
        expect(tokens.exchange("dashboard", first)).toBeUndefined();
        expect(tokens.exchange("other", second)).toBeUndefined();
        expect(tokens.exchange("dashboard", second)).toEqual({
            projectId: "project-1",
            version: 1,
            webapp: "dashboard",
        });
        expect(tokens.exchange("dashboard", second)).toBeUndefined();

        now += 100;
        expect(tokens.exchange("dashboard", third)).toBeUndefined();
    });
});
