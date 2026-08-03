import { describe, expect, it, vi } from "vitest";

import {
    MAXIMUM_RIG_PROTOCOL_VERSION,
    MINIMUM_RIG_PROTOCOL_VERSION,
} from "@/ServerCompatibility.js";
import {
    discoverRigInstallation,
    MAXIMUM_INSTALLATION_RESPONSE_BYTES,
    RigInstallationDiscoveryHttpError,
    RigInstallationDiscoveryTimeoutError,
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

    it("cancels a non-404 HTTP response before throwing its typed status error", async () => {
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            cancel() {
                cancelled = true;
            },
            start(controller) {
                controller.enqueue(new TextEncoder().encode("forbidden"));
            },
        });

        const result = discoverRigInstallation({
            endpoint: "http://daemon.test",
            fetch: async () => new Response(body, { status: 403 }),
            token: "secret",
        });

        await expect(result).rejects.toMatchObject({
            name: RigInstallationDiscoveryHttpError.name,
            status: 403,
        });
        expect(cancelled).toBe(true);
    });

    it("cancels a streamed response that exceeds the 16 KB limit", async () => {
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            cancel() {
                cancelled = true;
            },
            start(controller) {
                controller.enqueue(new Uint8Array(MAXIMUM_INSTALLATION_RESPONSE_BYTES + 1));
            },
        });

        await expect(
            discoverRigInstallation({
                endpoint: "http://daemon.test",
                fetch: async () => new Response(body),
                token: "secret",
            }),
        ).rejects.toThrow("Rig returned an installation response larger than 16 KB.");
        expect(cancelled).toBe(true);
    });

    it("cancels a response whose declared content length exceeds the 16 KB limit", async () => {
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            cancel() {
                cancelled = true;
            },
            start(controller) {
                controller.enqueue(new TextEncoder().encode("{}"));
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

    it("cancels and releases a reader that fails while reading the response", async () => {
        const reader = {
            cancel: vi.fn().mockResolvedValue(undefined),
            read: vi.fn().mockRejectedValue(new Error("stream failed")),
            releaseLock: vi.fn(),
        };
        const response = {
            body: { getReader: () => reader },
            headers: new Headers(),
            ok: true,
        } as unknown as Response;

        await expect(
            discoverRigInstallation({
                endpoint: "http://daemon.test",
                fetch: async () => response,
                token: "secret",
            }),
        ).rejects.toThrow("stream failed");
        expect(reader.cancel).toHaveBeenCalledTimes(1);
        expect(reader.releaseLock).toHaveBeenCalledTimes(1);
    });

    it("preserves a caller abort and removes its temporary listener", async () => {
        const caller = new AbortController();
        const callerError = new Error("The caller stopped discovery.");
        const addEventListener = vi.spyOn(caller.signal, "addEventListener");
        const removeEventListener = vi.spyOn(caller.signal, "removeEventListener");
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            cancel() {
                cancelled = true;
            },
        });
        const request = discoverRigInstallation({
            endpoint: "http://daemon.test",
            fetch: async () => new Response(body),
            signal: caller.signal,
            token: "secret",
        });
        const expectation = expect(request).rejects.toBe(callerError);

        caller.abort(callerError);

        await expectation;
        expect(cancelled).toBe(true);
        expect(addEventListener).toHaveBeenCalledWith("abort", expect.any(Function), {
            once: true,
        });
        expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
    });

    it("preserves a network failure instead of misclassifying it as a timeout", async () => {
        const networkError = new Error("The network connection closed.");

        await expect(
            discoverRigInstallation({
                endpoint: "http://daemon.test",
                fetch: async () => {
                    throw networkError;
                },
                timeoutMs: 1,
                token: "secret",
            }),
        ).rejects.toBe(networkError);
    });

    it("uses the first abort cause when a fetch response arrives after cancellation", async () => {
        const caller = new AbortController();
        const callerError = new Error("The caller stopped discovery.");
        let resolveCallerResponse: (response: Response) => void;
        const callerResponse = new Promise<Response>((resolve) => {
            resolveCallerResponse = resolve;
        });
        const callerRequest = discoverRigInstallation({
            endpoint: "http://daemon.test",
            fetch: async () => callerResponse,
            signal: caller.signal,
            token: "secret",
        });
        const callerExpectation = expect(callerRequest).rejects.toBe(callerError);

        caller.abort(callerError);
        resolveCallerResponse!(new Response(JSON.stringify(discovery())));

        await callerExpectation;

        vi.useFakeTimers();
        try {
            let resolveTimeoutResponse: (response: Response) => void;
            const timeoutResponse = new Promise<Response>((resolve) => {
                resolveTimeoutResponse = resolve;
            });
            const timeoutRequest = discoverRigInstallation({
                endpoint: "http://daemon.test",
                fetch: async () => timeoutResponse,
                timeoutMs: 1,
                token: "secret",
            });
            const timeoutExpectation = expect(timeoutRequest).rejects.toBeInstanceOf(
                RigInstallationDiscoveryTimeoutError,
            );

            await vi.advanceTimersByTimeAsync(1);
            resolveTimeoutResponse!(new Response(JSON.stringify(discovery())));

            await timeoutExpectation;
        } finally {
            vi.useRealTimers();
        }
    });

    it("reports a typed timeout and cancels an in-progress response read", async () => {
        vi.useFakeTimers();
        try {
            let cancelled = false;
            const body = new ReadableStream<Uint8Array>({
                cancel() {
                    cancelled = true;
                },
            });
            const request = discoverRigInstallation({
                endpoint: "http://daemon.test",
                fetch: async () => new Response(body),
                timeoutMs: 1,
                token: "secret",
            });
            const expectation = expect(request).rejects.toBeInstanceOf(
                RigInstallationDiscoveryTimeoutError,
            );

            await vi.advanceTimersByTimeAsync(1);

            await expectation;
            expect(cancelled).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });
});
