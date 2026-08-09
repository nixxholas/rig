import { describe, expect, it } from "vitest";

import {
    MAXIMUM_RIG_PROTOCOL_VERSION,
    MINIMUM_RIG_PROTOCOL_VERSION,
    serverCompatibility,
} from "../sources/ServerCompatibility.js";

describe("serverCompatibility", () => {
    it("requires protocol v17 without a legacy compatibility path", () => {
        expect(MINIMUM_RIG_PROTOCOL_VERSION).toBe(17);
        expect(serverCompatibility(16)).toMatchObject({
            status: "server_outdated",
        });
    });

    it("distinguishes a compatible daemon from either upgrade direction", () => {
        expect(serverCompatibility(MINIMUM_RIG_PROTOCOL_VERSION)).toMatchObject({
            status: "compatible",
            serverProtocolVersion: MINIMUM_RIG_PROTOCOL_VERSION,
        });
        expect(serverCompatibility(MINIMUM_RIG_PROTOCOL_VERSION - 1)).toMatchObject({
            status: "server_outdated",
        });
        expect(serverCompatibility(MAXIMUM_RIG_PROTOCOL_VERSION + 1)).toMatchObject({
            status: "client_outdated",
        });
    });

    it("treats a missing or malformed handshake as an old unsupported daemon", () => {
        expect(serverCompatibility(undefined as never)).toMatchObject({
            serverProtocolVersion: 0,
            status: "server_outdated",
        });
    });
});
