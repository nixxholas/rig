import { describe, expect, it } from "vitest";

import { formatManagedNetworkDenial } from "../../../sources/network/impl/formatManagedNetworkDenial.js";

describe("formatManagedNetworkDenial", () => {
    it("names the project network policy files declared by the embedder", () => {
        const message = formatManagedNetworkDenial(
            {
                host: "blocked.example",
                port: 443,
                protocol: "https_connect",
                reason: "not_allowed",
            },
            { networkPolicyFiles: ["agent-policy.toml", "fallback-policy.toml"] },
        );

        expect(message).toContain("'agent-policy.toml' or 'fallback-policy.toml'");
        expect(message).not.toMatch(/\/(?:Users|home)\//u);
    });

    it("uses generic guidance when no network policy files are declared", () => {
        const message = formatManagedNetworkDenial({
            host: "blocked.example",
            port: 443,
            protocol: "https_connect",
            reason: "not_allowed",
        });

        expect(message).toContain("update the network policy");
        expect(message).not.toContain(".toml");
    });
});
