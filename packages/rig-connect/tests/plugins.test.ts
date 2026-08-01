import { describe, expect, it, vi } from "vitest";

import { connectRig } from "@/connectRig.js";
import type { PluginSummary } from "@/protocol.js";

const CURSOR_1 = "01900000-0000-7000-8000-000000000001";
const CURSOR_2 = "01900000-0000-7000-8000-000000000002";
const CURSOR_3 = "01900000-0000-7000-8000-000000000003";

describe("plugin application projection", () => {
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
            expect(connection.applications()).toMatchObject([
                { generation: "generation-2", id: "usage:overview", pluginId: "usage" },
            ]);
        });
        const application = connection.applications()[0];
        const pluginReference = connection.plugins()[0];
        stream.enqueue(encoder.encode(pluginsChanged(CURSOR_3, [plugin("generation-2")])));
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(connection.applications()[0]).toBe(application);
        expect(connection.plugins()[0]).toBe(pluginReference);

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

        await vi.waitFor(() =>
            expect(connection.applications()[0]?.generation).toBe("generation-3"),
        );
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
        await vi.waitFor(() =>
            expect(connection.applications()[0]?.generation).toBe("generation-1"),
        );

        streams[0]!.close();
        await vi.waitFor(() => expect(streams).toHaveLength(2));
        streams[1]!.enqueue(encoder.encode(hello(CURSOR_2, false, true)));
        await vi.waitFor(() => expect(connection.state().connection).toBe("live"));
        expect(catalogReads).toBe(1);

        streams[1]!.close();
        await vi.waitFor(() => expect(streams).toHaveLength(3));
        streams[2]!.enqueue(encoder.encode(hello(CURSOR_3, true, false)));
        await vi.waitFor(() =>
            expect(connection.applications()[0]?.generation).toBe("generation-2"),
        );
        expect(catalogReads).toBe(2);

        connection.close();
        rig.close();
        streams[2]!.close();
    });

    it("loads declared resources, forwards actions, and rejects oversized host responses", async () => {
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
            if (url.endsWith("/resources/index.html")) {
                expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
                return new Response("<h1>Usage</h1>", {
                    headers: {
                        "content-length": "14",
                        "content-type": "text/html; charset=utf-8",
                    },
                });
            }
            if (url.endsWith("/resources/large.js")) {
                return new Response("x", {
                    headers: {
                        "content-length": String(256 * 1024 + 1),
                        "content-type": "text/javascript",
                    },
                });
            }
            if (url.endsWith("/actions/read")) {
                expect(init?.method).toBe("POST");
                expect(JSON.parse(String(init?.body))).toEqual({ input: { scope: "weekly" } });
                return Response.json({ result: { usedPercent: 42 } });
            }
            if (url.endsWith("/actions/broken")) return Response.json({});
            return new Response("not found", { status: 404 });
        });
        const rig = connectRig({ endpoint: "http://rig.test", fetch, token: "secret" });
        const connection = rig.connectPlugins({ onChange: () => undefined });
        stream.enqueue(encoder.encode(hello(CURSOR_1, false, false)));
        await vi.waitFor(() => expect(connection.applications()).toHaveLength(1));
        const application = connection.applications()[0]!;

        await expect(connection.loadResource(application, "index.html")).resolves.toMatchObject({
            body: new TextEncoder().encode("<h1>Usage</h1>"),
            mediaType: "text/html",
        });
        await expect(
            connection.invokeAction(application, "read", { scope: "weekly" }),
        ).resolves.toEqual({ usedPercent: 42 });
        await expect(connection.invokeAction(application, "broken", {})).rejects.toThrow(
            "invalid plugin application action response",
        );
        await expect(
            connection.invokeAction(application, "read", { value: "x".repeat(1024 * 1024) }),
        ).rejects.toThrow("exceeds the host limit");
        await expect(connection.loadResource(application, "large.js")).rejects.toThrow(
            "more plugin application data",
        );

        connection.close();
        await expect(connection.invokeAction(application, "read", {})).rejects.toThrow(
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
        applications: [
            {
                actions: ["broken", "read"],
                applicationId: "overview",
                entry: "index.html",
                generation,
                id: "usage:overview",
                navigation: { label: "Usage", order: 10 },
                pluginFolder: "usage",
                resources: [
                    { mediaType: "text/html", path: "index.html", size: 14 },
                    ...(withLargeResource
                        ? [
                              {
                                  mediaType: "text/javascript" as const,
                                  path: "large.js",
                                  size: 256 * 1024,
                              },
                          ]
                        : []),
                ],
                title: "Usage",
            },
        ],
        dataDirectory: "/data/usage",
        description: "Provider usage.",
        directory: "/plugins/usage",
        folder: "usage",
        logAvailable: false,
        name: "Usage",
        status: "running",
    };
}

function hello(cursor: string, gap: boolean, resumed: boolean): string {
    return sse("hello", { cursor, gap, protocolVersion: 2, resumed });
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
