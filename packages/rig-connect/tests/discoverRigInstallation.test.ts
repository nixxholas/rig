import { describe, expect, it } from "vitest";

import {
    MAXIMUM_RIG_PROTOCOL_VERSION,
    MINIMUM_RIG_PROTOCOL_VERSION,
} from "@/ServerCompatibility.js";
import {
    discoverRigInstallation,
    MAXIMUM_INSTALLATION_RESPONSE_BYTES,
    RigInstallationDiscoveryUnsupportedError,
    rigInstallationCompatibility,
} from "@/discoverRigInstallation.js";
import type { RigDaemonInstallationDiscovery } from "@/RigInstallationInspection.js";

function discovery(
    daemonProtocolVersion = MINIMUM_RIG_PROTOCOL_VERSION,
): RigDaemonInstallationDiscovery {
    return {
        daemonProtocolVersion,
        daemonVersion: "0.0.127",
        data: {
            epoch: "installation-epoch",
            schemaCompatibility: "current",
            schemaVersion: 18,
            status: "initialized",
        },
        formatVersion: 1,
        source: "daemon",
    };
}

describe("discoverRigInstallation", () => {
    it("sends one authenticated GET request without opening a live stream", async () => {
        const calls: { init: RequestInit | undefined; url: string }[] = [];
        const result = await discoverRigInstallation({
            endpoint: "https://connector.test/capability/rig?tenant=acme",
            fetch: async (input, init) => {
                calls.push({ init, url: String(input) });
                return new Response(JSON.stringify(discovery()));
            },
            token: "installation-token",
        });

        expect(result).toEqual(discovery());
        expect(calls).toEqual([
            {
                init: {
                    headers: {
                        accept: "application/json",
                        authorization: "Bearer installation-token",
                    },
                    method: "GET",
                    signal: expect.any(AbortSignal),
                },
                url: "https://connector.test/capability/rig/installation?tenant=acme",
            },
        ]);
    });

    it("uses the daemon protocol version for compatibility", () => {
        expect(rigInstallationCompatibility(discovery()).status).toBe("compatible");
        expect(
            rigInstallationCompatibility(discovery(MINIMUM_RIG_PROTOCOL_VERSION - 1)).status,
        ).toBe("server_outdated");
        expect(
            rigInstallationCompatibility(discovery(MAXIMUM_RIG_PROTOCOL_VERSION + 1)).status,
        ).toBe("client_outdated");
    });

    it("rejects CLI inspection data from the daemon route", async () => {
        await expect(
            discoverRigInstallation({
                endpoint: "http://daemon.test",
                fetch: async () =>
                    new Response(
                        JSON.stringify({
                            cliProtocolVersion: 5,
                            cliVersion: "0.0.127",
                            data: { status: "absent" },
                            formatVersion: 1,
                            source: "cli",
                        }),
                    ),
                token: "secret",
            }),
        ).rejects.toThrow("Rig returned an invalid installation discovery response.");
    });

    it("classifies and cancels a 404 response from a server that predates discovery", async () => {
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            cancel() {
                cancelled = true;
            },
            start(controller) {
                controller.enqueue(new TextEncoder().encode("not found"));
            },
        });

        await expect(
            discoverRigInstallation({
                endpoint: "http://daemon.test",
                fetch: async () => new Response(body, { status: 404 }),
                token: "secret",
            }),
        ).rejects.toBeInstanceOf(RigInstallationDiscoveryUnsupportedError);
        expect(cancelled).toBe(true);

        try {
            await discoverRigInstallation({
                endpoint: "http://daemon.test",
                fetch: async () => new Response(null, { status: 404 }),
                token: "secret",
            });
        } catch (error) {
            expect(error).toMatchObject({
                compatibility: { status: "server_outdated" },
                status: 404,
            });
        }
    });

    it("bounds discovery time and response size", async () => {
        await expect(
            discoverRigInstallation({
                endpoint: "http://daemon.test",
                fetch: (_input, init) =>
                    new Promise((_resolve, reject) => {
                        init?.signal?.addEventListener(
                            "abort",
                            () => reject(new DOMException("Aborted", "AbortError")),
                            { once: true },
                        );
                    }),
                timeoutMs: 1,
                token: "secret",
            }),
        ).rejects.toThrow("Rig installation discovery timed out.");

        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            cancel() {
                cancelled = true;
            },
        });
        await expect(
            discoverRigInstallation({
                endpoint: "http://daemon.test",
                fetch: async () =>
                    new Response(body, {
                        headers: {
                            "content-length": String(MAXIMUM_INSTALLATION_RESPONSE_BYTES + 1),
                        },
                    }),
                token: "secret",
            }),
        ).rejects.toThrow("Rig returned an installation response larger than 16 KB.");
        expect(cancelled).toBe(true);
    });
});
