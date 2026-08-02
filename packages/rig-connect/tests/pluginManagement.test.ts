import { describe, expect, it, vi } from "vitest";

import { connectRig, PluginManagementRequestError } from "@/index.js";

describe("plugin management", () => {
    it("installs from a daemon-local source folder and uninstalls by name", async () => {
        const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
            const url = String(input);
            if (url.endsWith("/plugins") && init?.method === "POST") {
                expect(init.headers).toMatchObject({
                    authorization: "Bearer secret",
                    "content-type": "application/json",
                });
                expect(JSON.parse(String(init.body))).toEqual({
                    sourceDirectory: "/Users/steve/Developer/plugins/packages/hello-world",
                });
                return Response.json(
                    {
                        plugin: {
                            description: "Lists local projects.",
                            directory: "/managed/hello-world",
                            folder: "hello-world",
                            name: "Hello World",
                        },
                    },
                    { status: 201 },
                );
            }
            if (url.endsWith("/plugins/Hello%20World") && init?.method === "DELETE") {
                expect(init.headers).toMatchObject({ authorization: "Bearer secret" });
                return Response.json({
                    plugin: {
                        dataDirectory: "/data/hello-world",
                        folder: "hello-world",
                        name: "Hello World",
                    },
                });
            }
            return new Response("not found", { status: 404 });
        });
        const rig = connectRig({ endpoint: "http://rig.test", fetch, token: "secret" });

        await expect(
            rig.installPlugin("/Users/steve/Developer/plugins/packages/hello-world"),
        ).resolves.toEqual({
            description: "Lists local projects.",
            directory: "/managed/hello-world",
            folder: "hello-world",
            name: "Hello World",
        });
        await expect(rig.uninstallPlugin("Hello World")).resolves.toEqual({
            dataDirectory: "/data/hello-world",
            folder: "hello-world",
            name: "Hello World",
        });

        rig.close();
    });

    it("surfaces stable daemon error codes and validates successful envelopes", async () => {
        const fetch = vi
            .fn<typeof globalThis.fetch>()
            .mockResolvedValueOnce(
                Response.json(
                    {
                        error: {
                            code: "install_failed",
                            message: "The plugin does not compile.",
                        },
                    },
                    { status: 422 },
                ),
            )
            .mockResolvedValueOnce(Response.json({ plugin: { name: "incomplete" } }));
        const rig = connectRig({ endpoint: "http://rig.test", fetch, token: "secret" });

        const failure = await rig.installPlugin("/plugins/broken").catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(PluginManagementRequestError);
        expect(failure).toMatchObject({
            code: "install_failed",
            message: "The plugin does not compile.",
            status: 422,
        });
        await expect(rig.uninstallPlugin("Broken")).rejects.toThrow(
            "Rig returned an invalid plugin management response.",
        );

        rig.close();
    });

    it("passes cancellation to the fetch boundary", async () => {
        const fetch = vi.fn<typeof globalThis.fetch>(
            (_input, init) =>
                new Promise<Response>((_resolve, reject) => {
                    const signal = init?.signal;
                    if (signal === undefined || signal === null) {
                        throw new Error("Expected an operation signal.");
                    }
                    signal.addEventListener(
                        "abort",
                        () => reject(new DOMException("Aborted", "AbortError")),
                        { once: true },
                    );
                }),
        );
        const controller = new AbortController();
        const rig = connectRig({ endpoint: "http://rig.test", fetch, token: "secret" });
        const installing = rig.installPlugin("/plugins/slow", { signal: controller.signal });

        controller.abort();

        await expect(installing).rejects.toMatchObject({ name: "AbortError" });
        expect(fetch.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
        rig.close();
    });
});
