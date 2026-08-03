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
                    requestId: "install-local-1",
                    source: {
                        sourceDirectory: "/Users/steve/Developer/plugins/packages/hello-world",
                        type: "local-directory",
                    },
                });
                return Response.json(
                    {
                        plugin: {
                            classification: "fresh-install",
                            description: "Lists local projects.",
                            directory: "/managed/hello-world",
                            folder: "hello-world",
                            name: "Hello World",
                            version: "1.0.0",
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
            rig.installPlugin("/Users/steve/Developer/plugins/packages/hello-world", {
                requestId: "install-local-1",
            }),
        ).resolves.toEqual({
            classification: "fresh-install",
            description: "Lists local projects.",
            directory: "/managed/hello-world",
            folder: "hello-world",
            name: "Hello World",
            version: "1.0.0",
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
                            message: "The plugin main entry point is missing.",
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
            message: "The plugin main entry point is missing.",
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
        expect(fetch.mock.calls[0]?.[1]?.signal).toMatchObject({ aborted: true });
        rig.close();
    });

    it("discovers a pinned catalog and retries installation with one request identity", async () => {
        const source = {
            catalogId: "a".repeat(64),
            plugin: {
                description: "A small clock.",
                displayName: "Clock",
                name: "clock",
                path: "plugins/clock",
                version: "1.2.0",
            },
            repository: "happy-dev/plugins",
            revision: "b".repeat(40),
            type: "github" as const,
        };
        const installBodies: unknown[] = [];
        let installAttempts = 0;
        const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
            const url = String(input);
            if (url.endsWith("/plugin-catalogs/github")) {
                expect(init?.headers).toMatchObject({ authorization: "Bearer secret" });
                return Response.json({
                    catalogId: source.catalogId,
                    plugins: [
                        {
                            availability: "update-available",
                            description: source.plugin.description,
                            displayName: source.plugin.displayName,
                            installed: { folder: "clock", name: "Clock", version: "1.0.0" },
                            name: source.plugin.name,
                            source,
                            version: source.plugin.version,
                        },
                    ],
                    repository: source.repository,
                    revision: source.revision,
                });
            }
            if (url.endsWith("/plugins") && init?.method === "POST") {
                installBodies.push(JSON.parse(String(init.body)) as unknown);
                installAttempts += 1;
                if (installAttempts === 1) throw new TypeError("response lost");
                return Response.json(
                    {
                        plugin: {
                            classification: "upgrade",
                            description: "A small clock.",
                            directory: "/managed/clock",
                            folder: "clock",
                            name: "Clock",
                            version: "1.2.0",
                        },
                    },
                    { status: 201 },
                );
            }
            return new Response("not found", { status: 404 });
        });
        const rig = connectRig({
            endpoint: "http://rig.test",
            fetch,
            mutationRetryDelayMs: 0,
            token: "secret",
            wait: async () => {},
        });

        const catalog = await rig.discoverPluginCatalog({ repository: "happy-dev/plugins" });
        expect(catalog.plugins[0]).toMatchObject({
            availability: "update-available",
            installed: { version: "1.0.0" },
            source,
        });
        await expect(
            rig.installPlugin(catalog.plugins[0]!.source, {
                requestId: "install-clock-1",
            }),
        ).resolves.toMatchObject({ classification: "upgrade", version: "1.2.0" });
        expect(installBodies).toEqual([
            { requestId: "install-clock-1", source },
            { requestId: "install-clock-1", source },
        ]);

        rig.close();
    });

    it("reports a typed failure after repeated installation transport failures", async () => {
        const fetch = vi
            .fn<typeof globalThis.fetch>()
            .mockRejectedValue(new TypeError("connection lost"));
        const rig = connectRig({
            endpoint: "http://rig.test",
            fetch,
            mutationRetryDelayMs: 0,
            token: "secret",
            wait: async () => {},
        });

        const failure = await rig
            .installPlugin("/plugins/clock", { requestId: "install-clock-1" })
            .catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(PluginManagementRequestError);
        expect(failure).toMatchObject({
            code: "request_failed",
            status: 0,
        });
        expect(fetch).toHaveBeenCalledTimes(3);
        expect(
            fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as unknown),
        ).toEqual([
            {
                requestId: "install-clock-1",
                source: { sourceDirectory: "/plugins/clock", type: "local-directory" },
            },
            {
                requestId: "install-clock-1",
                source: { sourceDirectory: "/plugins/clock", type: "local-directory" },
            },
            {
                requestId: "install-clock-1",
                source: { sourceDirectory: "/plugins/clock", type: "local-directory" },
            },
        ]);

        rig.close();
    });
});
