import { describe, expect, it, vi } from "vitest";

import { resolveGlobalDevelopmentIdentityVersion } from "./resolveGlobalDevelopmentIdentityVersion.js";

describe("resolveGlobalDevelopmentIdentityVersion", () => {
    it("keeps the running production identity so installed clients do not replace source", async () => {
        const readInstalledVersion = vi.fn(async () => "0.2.2");

        await expect(
            resolveGlobalDevelopmentIdentityVersion({
                currentSourceVersion: "0.2.7",
                readInstalledVersion,
                readRunningVersion: async () => "0.2.3",
            }),
        ).resolves.toBe("0.2.3");
        expect(readInstalledVersion).not.toHaveBeenCalled();
    });

    it("uses the installed identity when no daemon is running", async () => {
        await expect(
            resolveGlobalDevelopmentIdentityVersion({
                currentSourceVersion: "0.2.7",
                readInstalledVersion: async () => "0.2.3",
                readRunningVersion: async () => undefined,
            }),
        ).resolves.toBe("0.2.3");
    });

    it("falls back to current source without a production installation", async () => {
        await expect(
            resolveGlobalDevelopmentIdentityVersion({
                currentSourceVersion: "0.2.7",
                readInstalledVersion: async () => undefined,
                readRunningVersion: async () => undefined,
            }),
        ).resolves.toBe("0.2.7");
    });
});
