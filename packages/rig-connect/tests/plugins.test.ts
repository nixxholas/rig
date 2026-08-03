import { describe, expect, it, vi } from "vitest";

import { connectRig } from "@/connectRig.js";
import { PluginStore } from "@/PluginElement.js";
import type { PluginSummary } from "@/protocol.js";

const CURSOR_1 = "01900000-0000-7000-8000-000000000001";
const CURSOR_2 = "01900000-0000-7000-8000-000000000002";
const CURSOR_3 = "01900000-0000-7000-8000-000000000003";

describe("plugin MCP App projection", () => {
    it("drops an invalid catalog contribution and surfaces a scoped failure", () => {
        const store = new PluginStore();
        const valid = plugin("generation-1");
        const invalid = {
            ...valid,
            apps: valid.apps.map((app) => ({ ...app, resourceUri: "ui://broken#fragment" })),
        };
        expect(store.replace([invalid], [], "live")).toBe(true);
        expect(store.plugins()).toEqual([]);
        expect(store.state().failures).toEqual([
            {
                error: "Rig returned invalid catalog metadata for this plugin.",
                pluginId: "usage",
            },
        ]);
    });

    it("isolates invalid catalog display metadata at the browser boundary", () => {
        const store = new PluginStore();
        store.replace([{ ...plugin("generation-1"), author: "" }], [], "live");
        expect(store.plugins()).toEqual([]);
        expect(store.state().failures[0]?.pluginId).toBe("usage");
        store.replace(
            [{ ...plugin("generation-1"), category: "uncategorized" as never }],
            [],
            "live",
        );
        expect(store.plugins()).toEqual([]);
        expect(store.state().connection).toBe("live");
        store.replace([{ ...plugin("generation-1"), author: "Happy\u202eTools" }], [], "live");
        expect(store.plugins()).toEqual([]);
    });

    it("keeps icon identity stable across unrelated plugin status changes", () => {
        const store = new PluginStore();
        store.replace([plugin("generation-1")], [], "live");
        const icon = store.plugins()[0]!.icon;
        store.replace([{ ...plugin("generation-1"), status: "failed" }], [], "live");
        expect(store.plugins()[0]!.icon).toBe(icon);
    });

    it("rebases a stream change that lands during the opening snapshot without losing it", async () => {
        const encoder = new TextEncoder();
        let stream!: ReadableStreamDefaultController<Uint8Array>;
        const catalog = deferred<Response>();
        const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
            const url = String(input);
            if (url.endsWith("/events/live")) {
                return new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            stream = controller;
                        },
                    }),
                );
            }
            if (url.endsWith("/plugins")) return catalog.promise;
            return new Response("not found", { status: 404 });
        });
        const changed = vi.fn();
        const rig = connectRig({ endpoint: "http://rig.test", fetch, token: "secret" });
        const connection = rig.connectPlugins({ onChange: changed });

        stream.enqueue(encoder.encode(hello(CURSOR_1, false, false)));
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
        const current = pluginsChanged(CURSOR_2, [plugin("generation-2")]);
        stream.enqueue(encoder.encode(current));
        catalog.resolve(
            Response.json({ cursor: CURSOR_1, failures: [], plugins: [], version: CURSOR_1 }),
        );

        await vi.waitFor(() => {
            expect(connection.apps()).toMatchObject([
                { generation: "generation-2", id: "usage:overview", pluginId: "usage" },
            ]);
        });
        expect(connection.plugins()).toMatchObject([
            { id: "usage", statusMessage: "Watching provider usage." },
        ]);
        const application = connection.apps()[0];
        const pluginReference = connection.plugins()[0];
        stream.enqueue(encoder.encode(pluginsChanged(CURSOR_3, [plugin("generation-2")])));
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(connection.apps()[0]).toBe(application);
        expect(connection.plugins()[0]).toBe(pluginReference);

        connection.close();
        rig.close();
        stream.close();
    });

    it("keeps the live stream open when one event contains a malformed plugin summary", async () => {
        const encoder = new TextEncoder();
        let stream!: ReadableStreamDefaultController<Uint8Array>;
        const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
            if (String(input).endsWith("/events/live")) {
                return new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            stream = controller;
                        },
                    }),
                );
            }
            return Response.json({
                cursor: CURSOR_1,
                failures: [],
                plugins: [plugin("generation-1")],
                version: CURSOR_1,
            });
        });
        const rig = connectRig({ endpoint: "http://rig.test", fetch, token: "secret" });
        const connection = rig.connectPlugins({ onChange: () => undefined });
        stream.enqueue(encoder.encode(hello(CURSOR_1, false, false)));
        await vi.waitFor(() => expect(connection.plugins()).toHaveLength(1));

        stream.enqueue(
            encoder.encode(
                pluginsChanged(CURSOR_2, [
                    { ...plugin("generation-2"), author: "" },
                    { ...plugin("generation-2"), folder: "healthy", name: "Healthy" },
                ]),
            ),
        );
        await vi.waitFor(() =>
            expect(connection.plugins().map(({ id }) => id)).toEqual(["healthy"]),
        );
        expect(connection.state()).toMatchObject({
            connection: "live",
            failures: [{ pluginId: "usage" }],
        });
        stream.enqueue(
            encoder.encode(
                pluginsChanged(CURSOR_3, [
                    { ...plugin("generation-3"), folder: "healthy", name: "Healthy" },
                ]),
            ),
        );
        await vi.waitFor(() => expect(connection.apps()[0]?.generation).toBe("generation-3"));
        expect(
            fetch.mock.calls.filter(([input]) => String(input).endsWith("/events/live")),
        ).toHaveLength(1);

        connection.close();
        rig.close();
        stream.close();
    });

    it("keeps a newer versioned snapshot when an older stream event arrived during it", async () => {
        const encoder = new TextEncoder();
        let stream!: ReadableStreamDefaultController<Uint8Array>;
        const catalog = deferred<Response>();
        const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
            const url = String(input);
            if (url.endsWith("/events/live")) {
                return new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            stream = controller;
                        },
                    }),
                );
            }
            if (url.endsWith("/plugins")) return catalog.promise;
            return new Response("not found", { status: 404 });
        });
        const rig = connectRig({ endpoint: "http://rig.test", fetch, token: "secret" });
        const connection = rig.connectPlugins({ onChange: () => undefined });

        stream.enqueue(encoder.encode(hello(CURSOR_1, false, false)));
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
        stream.enqueue(encoder.encode(pluginsChanged(CURSOR_2, [plugin("generation-2")])));
        catalog.resolve(
            Response.json({
                cursor: CURSOR_1,
                failures: [],
                plugins: [plugin("generation-3")],
                version: CURSOR_3,
            }),
        );

        await vi.waitFor(() => expect(connection.apps()[0]?.generation).toBe("generation-3"));
        connection.close();
        rig.close();
        stream.close();
    });

    it("resumes without reloading, reloads after a gap, and aborts owned work on cleanup", async () => {
        const encoder = new TextEncoder();
        const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
        let catalogReads = 0;
        const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
            const url = String(input);
            if (url.includes("/events/live")) {
                return new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            streams.push(controller);
                        },
                    }),
                );
            }
            if (url.endsWith("/plugins")) {
                catalogReads += 1;
                return Response.json({
                    cursor: catalogReads === 1 ? CURSOR_1 : CURSOR_3,
                    failures: [],
                    plugins: [plugin(`generation-${String(catalogReads)}`)],
                    version: catalogReads === 1 ? CURSOR_1 : CURSOR_3,
                });
            }
            return new Response("not found", { status: 404 });
        });
        const rig = connectRig({
            endpoint: "http://rig.test",
            fetch,
            token: "secret",
            wait: async () => undefined,
        });
        const connection = rig.connectPlugins({ onChange: () => undefined });

        await vi.waitFor(() => expect(streams).toHaveLength(1));
        streams[0]!.enqueue(encoder.encode(hello(CURSOR_1, false, false)));
        await vi.waitFor(() => expect(connection.apps()[0]?.generation).toBe("generation-1"));

        streams[0]!.close();
        await vi.waitFor(() => expect(streams).toHaveLength(2));
        streams[1]!.enqueue(encoder.encode(hello(CURSOR_2, false, true)));
        await vi.waitFor(() => expect(connection.state().connection).toBe("live"));
        expect(catalogReads).toBe(1);

        streams[1]!.close();
        await vi.waitFor(() => expect(streams).toHaveLength(3));
        streams[2]!.enqueue(encoder.encode(hello(CURSOR_3, true, false)));
        await vi.waitFor(() => expect(connection.apps()[0]?.generation).toBe("generation-2"));
        expect(catalogReads).toBe(2);

        connection.close();
        rig.close();
        streams[2]!.close();
    });

    it("reads declared resources, calls app-visible tools, and exposes namespaced storage", async () => {
        const encoder = new TextEncoder();
        let stream!: ReadableStreamDefaultController<Uint8Array>;
        const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
            const url = String(input);
            if (url.endsWith("/events/live")) {
                return new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            stream = controller;
                        },
                    }),
                );
            }
            if (url.endsWith("/plugins")) {
                return Response.json({
                    cursor: CURSOR_1,
                    failures: [],
                    plugins: [plugin("generation-1", true)],
                    version: CURSOR_1,
                });
            }
            if (url.endsWith("/resources/read")) {
                expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
                return Response.json({
                    contents: [
                        {
                            mimeType: "text/html;profile=mcp-app",
                            text: "<h1>Usage</h1>",
                            uri: "ui://usage/overview/index.html",
                        },
                    ],
                });
            }
            if (url.endsWith(`/generations/${"a".repeat(64)}/icon`)) {
                expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
                return new Response(new Uint8Array([137, 80, 78, 71]), {
                    headers: {
                        "content-length": "4",
                        "content-type": "image/png",
                    },
                });
            }
            if (url.endsWith(`/generations/${"b".repeat(64)}/icon`)) {
                return Response.json(
                    {
                        error: {
                            code: "stale_generation",
                            message: "That icon generation is stale.",
                        },
                    },
                    { status: 409 },
                );
            }
            if (url.endsWith("/tools/call")) {
                expect(init?.method).toBe("POST");
                const body = JSON.parse(String(init?.body)) as { name: string };
                if (body.name === "stale") {
                    return Response.json(
                        {
                            error: {
                                code: "stale_generation",
                                message: "That generation is stale.",
                            },
                        },
                        { status: 409 },
                    );
                }
                expect(body).toEqual({
                    arguments: { scope: "weekly" },
                    name: "read",
                    server: "Usage",
                });
                return Response.json({ result: { usedPercent: 42 } });
            }
            if (url.endsWith("/storage/set")) return Response.json({});
            if (url.endsWith("/storage/get")) return Response.json({ value: { compact: true } });
            return new Response("not found", { status: 404 });
        });
        const rig = connectRig({ endpoint: "http://rig.test", fetch, token: "secret" });
        const connection = rig.connectPlugins({ onChange: () => undefined });
        stream.enqueue(encoder.encode(hello(CURSOR_1, false, false)));
        await vi.waitFor(() => expect(connection.apps()).toHaveLength(1));
        const application = connection.apps()[0]!;
        const installed = connection.plugins()[0]!;

        await expect(connection.readIcon(installed)).resolves.toEqual({
            bytes: new Uint8Array([137, 80, 78, 71]),
            mediaType: "image/png",
        });
        await expect(
            connection.readIcon({
                ...installed,
                icon: { ...installed.icon, generation: "b".repeat(64) },
            }),
        ).rejects.toMatchObject({ code: "stale_generation", status: 409 });
        await expect(
            connection.readResource(application, "ui://usage/overview/index.html"),
        ).resolves.toMatchObject({
            contents: [{ mimeType: "text/html;profile=mcp-app", text: "<h1>Usage</h1>" }],
        });
        await expect(
            connection.callTool(application, "Usage", "read", { scope: "weekly" }),
        ).resolves.toEqual({ usedPercent: 42 });
        await expect(connection.callTool(application, "Usage", "stale", {})).rejects.toMatchObject({
            code: "stale_generation",
            status: 409,
        });
        await connection.storageSet(application, "layout", { compact: true });
        await expect(connection.storageGet(application, "layout")).resolves.toEqual({
            compact: true,
        });
        await expect(
            connection.callTool(application, "Usage", "read", {
                value: "x".repeat(1024 * 1024),
            }),
        ).rejects.toThrow("exceeds the host limit");

        connection.close();
        await expect(connection.readIcon(installed)).rejects.toThrow("connection is closed");
        await expect(connection.callTool(application, "Usage", "read", {})).rejects.toThrow(
            "connection is closed",
        );
        await expect(connection.storageGet(application, "layout")).rejects.toThrow(
            "connection is closed",
        );
        await expect(connection.storageList(application)).rejects.toThrow("connection is closed");
        await expect(connection.storageSet(application, "layout", null)).rejects.toThrow(
            "connection is closed",
        );
        await expect(connection.storageDelete(application, "layout")).rejects.toThrow(
            "connection is closed",
        );
        rig.close();
        stream.close();
    });

    it("aborts an opening catalog read when the last subscriber leaves", async () => {
        const encoder = new TextEncoder();
        let stream!: ReadableStreamDefaultController<Uint8Array>;
        let catalogAborted = false;
        const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
            if (String(input).endsWith("/events/live")) {
                return new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            stream = controller;
                        },
                    }),
                );
            }
            return new Promise<Response>((_resolve, reject) => {
                const abort = () => {
                    catalogAborted = true;
                    reject(new DOMException("Aborted", "AbortError"));
                };
                init?.signal?.addEventListener("abort", abort, { once: true });
            });
        });
        const onError = vi.fn();
        const onChange = vi.fn();
        const rig = connectRig({ endpoint: "http://rig.test", fetch, token: "secret" });
        const connection = rig.connectPlugins({ onChange, onError });
        stream.enqueue(encoder.encode(hello(CURSOR_1, false, false)));
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));

        connection.close();
        await vi.waitFor(() => expect(catalogAborted).toBe(true));
        expect(onError).not.toHaveBeenCalled();
        expect(onChange).toHaveBeenCalledTimes(1);

        rig.close();
        stream.close();
    });
});

function plugin(generation: string, withLargeResource = false): PluginSummary {
    return {
        apps: [
            {
                appId: "overview",
                generation,
                id: "usage:overview",
                page: "index.html",
                pluginFolder: "usage",
                resourceUri: "ui://usage/overview/index.html",
                resources: [
                    {
                        mimeType: "text/html;profile=mcp-app",
                        path: "index.html",
                        size: 14,
                        uri: "ui://usage/overview/index.html",
                    },
                    ...(withLargeResource
                        ? [
                              {
                                  mimeType: "text/javascript",
                                  path: "large.js",
                                  size: 256 * 1024,
                                  uri: "ui://usage/overview/large.js",
                              },
                          ]
                        : []),
                ],
                sidebar: { label: "Usage", order: 10 },
                title: "Usage",
                tools: [
                    {
                        _meta: {
                            ui: {
                                resourceUri: "ui://usage/overview/index.html",
                                visibility: ["model", "app"],
                            },
                        },
                        description: "Read usage.",
                        name: "read",
                        server: "Usage",
                    },
                    {
                        _meta: {
                            ui: {
                                resourceUri: "ui://usage/overview/index.html",
                                visibility: ["app"],
                            },
                        },
                        description: "Exercise a stale error.",
                        name: "stale",
                        server: "Usage",
                    },
                ],
            },
        ],
        author: "Happy",
        category: "utilities",
        dataDirectory: "/data/usage",
        description: "Provider usage.",
        directory: "/plugins/usage",
        folder: "usage",
        icon: {
            generation: "a".repeat(64),
            mediaType: "image/png",
            size: 4,
        },
        logAvailable: false,
        name: "Usage",
        status: "running",
        statusMessage: "Watching provider usage.",
        version: "1.2.3",
    };
}

function hello(cursor: string, gap: boolean, resumed: boolean): string {
    return sse("hello", { cursor, gap, protocolVersion: 5, resumed });
}

function pluginsChanged(cursor: string, plugins: readonly PluginSummary[]): string {
    return sse("update", {
        cursor,
        event: {
            createdAt: 2,
            data: { failures: [], plugins, version: cursor },
            id: cursor,
            type: "plugins_changed",
        },
    });
}

function sse(name: string, data: unknown): string {
    return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolvePromise: (value: T | PromiseLike<T>) => void = () => {};
    const promise = new Promise<T>((resolve) => {
        resolvePromise = resolve;
    });
    return { promise, resolve: resolvePromise };
}
