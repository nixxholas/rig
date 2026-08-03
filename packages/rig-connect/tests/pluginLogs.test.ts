import { describe, expect, it, vi } from "vitest";

import { connectRig } from "@/connectRig.js";

describe("plugin logs", () => {
    it("reads typed plugin state and a bounded log without starting a polling loop", async () => {
        const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
            const url = String(input);
            if (url.endsWith("/plugins")) {
                return Response.json({
                    cursor: "01900000-0000-7000-8000-000000000001",
                    failures: [],
                    plugins: [
                        {
                            apps: [],
                            author: "Happy",
                            category: "utilities",
                            dataDirectory: "/home/steve/Happy/Plugins/clock",
                            description: "A clock.",
                            directory: "/home/steve/.happy/rig/plugins/clock",
                            folder: "clock",
                            icon: {
                                generation: "a".repeat(64),
                                mediaType: "image/png",
                                size: 128,
                            },
                            logAvailable: true,
                            name: "Clock",
                            status: "stopped",
                            version: "0.0.0",
                        },
                    ],
                    version: "01900000-0000-7000-8000-000000000001",
                });
            }
            if (url.endsWith("/plugins/Clock/log")) {
                return Response.json({
                    log: {
                        folder: "clock",
                        name: "Clock",
                        source: "current_run",
                        status: "stopped",
                        text: "[stdout] tick\n",
                        truncated: false,
                        updatedAt: 42,
                    },
                });
            }
            return new Response("not found", { status: 404 });
        });
        const rig = connectRig({
            endpoint: "http://rig.test",
            fetch,
            token: "secret",
        });

        await expect(rig.listPlugins()).resolves.toMatchObject({
            plugins: [{ name: "Clock", status: "stopped" }],
        });
        await expect(rig.readPluginLog("Clock")).resolves.toMatchObject({
            text: "[stdout] tick\n",
            truncated: false,
        });
        expect(fetch).toHaveBeenCalledTimes(2);

        rig.close();
    });

    it("delivers lifecycle changes on the shared stream without polling logs", async () => {
        const encoder = new TextEncoder();
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
            start(next) {
                controller = next;
            },
        });
        const changed = vi.fn();
        const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
            if (String(input).endsWith("/events/live")) {
                return new Response(stream, {
                    headers: { "content-type": "text/event-stream" },
                    status: 200,
                });
            }
            if (String(input).endsWith("/plugins")) {
                return Response.json({
                    cursor: "01900000-0000-7000-8000-000000000001",
                    failures: [],
                    plugins: [],
                    version: "01900000-0000-7000-8000-000000000001",
                });
            }
            return new Response("not found", { status: 404 });
        });
        const rig = connectRig({
            endpoint: "http://rig.test",
            fetch,
            token: "secret",
        });
        const connection = rig.connectPlugins({ onChange: changed });
        controller.enqueue(
            encoder.encode(
                sse("hello", {
                    cursor: "01900000-0000-7000-8000-000000000001",
                    gap: false,
                    protocolVersion: 5,
                    resumed: false,
                }),
            ),
        );
        controller.enqueue(
            encoder.encode(
                sse("update", {
                    cursor: "01900000-0000-7000-8000-000000000002",
                    event: {
                        createdAt: 2,
                        data: {
                            failures: [],
                            plugins: [
                                {
                                    apps: [],
                                    author: "Happy",
                                    category: "utilities",
                                    dataDirectory: "/plugins/clock",
                                    description: "A clock.",
                                    directory: "/managed/clock",
                                    folder: "clock",
                                    icon: {
                                        generation: "a".repeat(64),
                                        mediaType: "image/png",
                                        size: 128,
                                    },
                                    logAvailable: true,
                                    name: "Clock",
                                    status: "running",
                                    version: "0.0.0",
                                },
                            ],
                            version: "01900000-0000-7000-8000-000000000002",
                        },
                        id: "01900000-0000-7000-8000-000000000002",
                        type: "plugins_changed",
                    },
                }),
            ),
        );

        await vi.waitFor(() => {
            expect(changed).toHaveBeenLastCalledWith(
                [],
                [expect.objectContaining({ name: "Clock", status: "running" })],
                expect.objectContaining({ connection: "live" }),
            );
        });
        expect(fetch).toHaveBeenCalledTimes(2);

        connection.close();
        rig.close();
        controller.close();
    });
});

function sse(name: string, data: unknown): string {
    return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}
