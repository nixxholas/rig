import { describe, expect, it } from "vitest";

import {
    shouldApplyManagedNetworkPolicy,
    shouldBypassManagedProxyForLoopback,
    validateManagedNetworkLoopbackPorts,
} from "../../sources/network/ManagedNetworkPolicy.js";

describe("shouldApplyManagedNetworkPolicy", () => {
    it.each([
        ["auto", true],
        ["workspace_write", true],
        ["read_only", false],
        ["full_access", false],
    ] as const)("uses managed networking in %s mode: %s", (permissionMode, expected) => {
        expect(shouldApplyManagedNetworkPolicy(permissionMode)).toBe(expected);
    });
});

describe("shouldBypassManagedProxyForLoopback", () => {
    it("bypasses for an isolated network namespace", () => {
        expect(shouldBypassManagedProxyForLoopback(undefined, true)).toBe(true);
    });

    it("bypasses when macOS local binding is enabled", () => {
        expect(shouldBypassManagedProxyForLoopback({ allowLocalBinding: true }, false)).toBe(true);
    });

    it("bypasses when a host loopback port is bridged", () => {
        expect(shouldBypassManagedProxyForLoopback({ allowedLoopbackPorts: [443] }, false)).toBe(
            true,
        );
    });

    it("keeps localhost on the proxy path when macOS has no loopback access", () => {
        expect(shouldBypassManagedProxyForLoopback({}, false)).toBe(false);
    });
});

describe("validateManagedNetworkLoopbackPorts", () => {
    it.each([1080, 3128])("rejects reserved internal proxy port %s", (port) => {
        expect(() => validateManagedNetworkLoopbackPorts([port])).toThrow(
            "reserved for the managed network proxy",
        );
    });
});
