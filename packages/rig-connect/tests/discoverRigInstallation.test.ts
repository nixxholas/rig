import { describe, expect, it } from "vitest";

import {
    MAXIMUM_RIG_PROTOCOL_VERSION,
    MINIMUM_RIG_PROTOCOL_VERSION,
} from "@/ServerCompatibility.js";
import {
    discoverRigInstallation,
    rigInstallationCompatibility,
} from "@/discoverRigInstallation.js";
import type { RigInstallationInspection } from "@/RigInstallationInspection.js";

function inspection(
    data: RigInstallationInspection["data"],
    protocolVersion = MINIMUM_RIG_PROTOCOL_VERSION,
): RigInstallationInspection {
    return {
        data,
        formatVersion: 1,
        protocolVersion,
        rigVersion: "0.0.26",
    };
}

describe("discoverRigInstallation", () => {
    it("sends one authenticated GET request without opening a live stream", async () => {
        const calls: { init: RequestInit | undefined; url: string }[] = [];
        const controller = new AbortController();
        const result = await discoverRigInstallation({
            endpoint: "https://connector.test/capability/rig?tenant=acme",
            fetch: async (input, init) => {
                calls.push({ init, url: String(input) });
                return new Response(JSON.stringify(inspection({ status: "absent" })));
            },
            signal: controller.signal,
            token: "installation-token",
        });

        expect(result.data).toEqual({ status: "absent" });
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

    it.each([
        [{ status: "absent" }],
        [{ status: "uninitialized" }],
        [{ epoch: "installation-epoch", status: "initialized" }],
    ] satisfies readonly [RigInstallationInspection["data"]][])(
        "decodes the %o installation data state",
        async (data) => {
            const result = await discoverRigInstallation({
                endpoint: "http://daemon.test",
                fetch: async () => new Response(JSON.stringify(inspection(data))),
                token: "secret",
            });

            expect(result.data).toEqual(data);
        },
    );

    it("reports the inspected protocol's compatibility", () => {
        expect(
            rigInstallationCompatibility(inspection({ status: "initialized", epoch: "epoch" }))
                .status,
        ).toBe("compatible");
        expect(
            rigInstallationCompatibility(
                inspection(
                    { status: "initialized", epoch: "epoch" },
                    MINIMUM_RIG_PROTOCOL_VERSION - 1,
                ),
            ).status,
        ).toBe("server_outdated");
        expect(
            rigInstallationCompatibility(
                inspection(
                    { status: "initialized", epoch: "epoch" },
                    MAXIMUM_RIG_PROTOCOL_VERSION + 1,
                ),
            ).status,
        ).toBe("client_outdated");
    });

    it("rejects malformed installation metadata", async () => {
        await expect(
            discoverRigInstallation({
                endpoint: "http://daemon.test",
                fetch: async () =>
                    new Response(
                        JSON.stringify({
                            data: { status: "initialized" },
                            formatVersion: 2,
                            protocolVersion: "3",
                            rigVersion: 26,
                        }),
                    ),
                token: "secret",
            }),
        ).rejects.toThrow("Rig returned an invalid installation response.");
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

        await expect(
            discoverRigInstallation({
                endpoint: "http://daemon.test",
                fetch: async () => new Response("x".repeat(16 * 1_024 + 1)),
                token: "secret",
            }),
        ).rejects.toThrow("Rig returned an installation response larger than 16 KB.");
    });
});
