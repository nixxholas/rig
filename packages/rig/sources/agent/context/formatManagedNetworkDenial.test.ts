import { describe, expect, it } from "vitest";

import { formatManagedNetworkDenial } from "./formatManagedNetworkDenial.js";

describe("formatManagedNetworkDenial", () => {
    it("distinguishes repository and global config without exposing an absolute home path", () => {
        const message = formatManagedNetworkDenial({
            host: "blocked.example",
            port: 443,
            protocol: "https_connect",
            reason: "not_allowed",
        });

        expect(message).toContain("this repository's rig.toml (or its happy.toml fallback)");
        expect(message).toContain(
            process.platform === "darwin"
                ? "~/Happy/Config/happy.toml"
                : "~/happy/config/happy.toml",
        );
        expect(message).not.toMatch(/\/(?:Users|home)\//u);
    });

    it("points to the configured global directory without exposing its absolute value", () => {
        const previous = process.env.RIG_CONFIGURATION_DIRECTORY;
        process.env.RIG_CONFIGURATION_DIRECTORY = "/Users/private/custom";
        try {
            const message = formatManagedNetworkDenial({
                host: "blocked.example",
                port: 443,
                protocol: "https_connect",
                reason: "not_allowed",
            });

            expect(message).toContain("$RIG_CONFIGURATION_DIRECTORY/happy.toml");
            expect(message).not.toContain("/Users/private/custom");
        } finally {
            if (previous === undefined) delete process.env.RIG_CONFIGURATION_DIRECTORY;
            else process.env.RIG_CONFIGURATION_DIRECTORY = previous;
        }
    });
});
