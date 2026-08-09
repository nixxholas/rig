import { describe, expect, it, vi } from "vitest";

import { connectRig } from "@/connectRig.js";
import { WorkletManagementRequestError, WorkletStore } from "@/WorkletElement.js";
import type { WorkletSummary } from "@/protocol.js";

const CURSOR_1 = "01900000-0000-7000-8000-000000000001";
const CURSOR_2 = "01900000-0000-7000-8000-000000000002";
const CURSOR_3 = "01900000-0000-7000-8000-000000000003";

describe("worklet projection", () => {
    it("drops an invalid catalog entry and surfaces a scoped failure", () => {
        const store = new WorkletStore();

        expect(
            store.replace([{ ...worklet(), state: "confused" as never }, worklet("other")], "live"),
        ).toBe(true);
        expect(store.worklets().map((entry) => entry.id)).toEqual(["other"]);
        expect(store.state().failures).toEqual([
            {
                error: "Rig returned invalid catalog metadata for this worklet.",
                workletId: "github-watch",
            },
        ]);
    });

    it("keeps tool and version identity stable across unrelated status changes", () => {
        const store = new WorkletStore();
        store.replace([worklet()], "live");
        const before = store.worklets()[0]!;

        store.replace([{ ...worklet(), status: "Now watching two repositories." }], "live");
        const after = store.worklets()[0]!;

        expect(after).not.toBe(before);
        expect(after.tools).toBe(before.tools);
        expect(after.versions).toBe(before.versions);
        // An unchanged reading changes nothing at all, so a view never re-renders for nothing.
        expect(
            store.replace([{ ...worklet(), status: "Now watching two repositories." }], "live"),
        ).toBe(false);
    });

    it("sorts by name and reports a worklet that failed to start", () => {
        const store = new WorkletStore();

        store.replace(
            [
                worklet("zulu"),
                { ...worklet("alpha"), failure: "It exited with code 3.", state: "failed" },
            ],
            "live",
        );

        expect(store.worklets().map((entry) => entry.name)).toEqual(["alpha", "zulu"]);
        expect(store.worklets()[0]).toMatchObject({
            failure: "It exited with code 3.",
            state: "failed",
        });
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
            if (url.endsWith("/worklets")) return catalog.promise;
            return new Response("not found", { status: 404 });
        });
        const changed = vi.fn();
        const rig = connectRig({ endpoint: "http://rig.test", fetch, token: "secret" });
        const connection = rig.connectWorklets({ onChange: changed });

        stream.enqueue(encoder.encode(hello(CURSOR_1)));
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
        stream.enqueue(encoder.encode(workletsChanged(CURSOR_2, [worklet()])));
        catalog.resolve(Response.json({ version: CURSOR_1, worklets: [] }));

        // The snapshot is older than the buffered event, so the event wins outright.
        await vi.waitFor(() => {
            expect(connection.worklets()).toMatchObject([{ id: "github-watch", state: "running" }]);
        });

        stream.enqueue(encoder.encode(workletsChanged(CURSOR_3, [])));
        await vi.waitFor(() => expect(connection.worklets()).toEqual([]));
        connection.close();
        rig.close();
    });

    it("turns rig's refusal into an error a view can act on", async () => {
        const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
            const url = String(input);
            if (url.endsWith("/events/live")) {
                return new Response(new ReadableStream<Uint8Array>({ start() {} }));
            }
            if (url.endsWith("/worklets") && init?.method === "POST") {
                return Response.json(
                    { error: { code: "invalid_worklet", message: "That name is not kebab-case." } },
                    { status: 400 },
                );
            }
            if (url.endsWith("/worklets"))
                return Response.json({ version: CURSOR_1, worklets: [] });
            return new Response("not found", { status: 404 });
        });
        const rig = connectRig({ endpoint: "http://rig.test", fetch, token: "secret" });
        const connection = rig.connectWorklets({ onChange: () => {} });

        const failure = await connection
            .install({
                authorSessionId: "agent-1",
                iconPath: "/workspace/icon.png",
                path: "/workspace/watch",
            })
            .catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(WorkletManagementRequestError);
        expect(failure).toMatchObject({ code: "invalid_worklet", status: 400 });
        expect((failure as Error).message).toBe("That name is not kebab-case.");
        connection.close();
        rig.close();
    });

    it("sends the author session required by the daemon when installing", async () => {
        const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
            const url = String(input);
            if (url.endsWith("/events/live")) {
                return new Response(new ReadableStream<Uint8Array>({ start() {} }));
            }
            if (url.endsWith("/worklets") && init?.method === "POST") {
                expect(JSON.parse(String(init.body))).toEqual({
                    authorSessionId: "agent-42",
                    iconPath: "/workspace/icon.png",
                    path: "/workspace/watch",
                    sourceDescription: "Project fixture",
                });
                return Response.json({ worklet: worklet() });
            }
            if (url.endsWith("/worklets"))
                return Response.json({ version: CURSOR_1, worklets: [] });
            return new Response("not found", { status: 404 });
        });
        const rig = connectRig({ endpoint: "http://rig.test", fetch, token: "secret" });
        const connection = rig.connectWorklets({ onChange: () => {} });

        await expect(
            connection.install({
                authorSessionId: "agent-42",
                iconPath: "/workspace/icon.png",
                path: "/workspace/watch",
                sourceDescription: "Project fixture",
            }),
        ).resolves.toMatchObject({ id: "github-watch" });

        connection.close();
        rig.close();
    });
});

function worklet(name = "github-watch"): WorkletSummary {
    return {
        authorSessionId: "agent-1",
        createdAt: 1,
        currentVersion: 1,
        dataDirectory: `/home/steve/Happy/Worklets/${name}/Data`,
        description: "Watches a repository",
        iconThumbhash: "thumb",
        iconUrl: `/worklets/${name}/favicon.png`,
        name,
        permissions: { disk: "none", network: "none" },
        state: "running",
        status: "Watching one repository.",
        tools: [{ description: "Lists new commits.", name: "commits" }],
        updatedAt: 1,
        versions: [
            {
                changeDescription: "Initial import",
                createdAt: 1,
                description: "Watches a repository",
                permissions: { disk: "none", network: "none" },
                version: 1,
            },
        ],
    };
}

function hello(cursor: string): string {
    return sse("hello", { cursor, gap: false, protocolVersion: 15, resumed: false });
}

function workletsChanged(cursor: string, worklets: readonly WorkletSummary[]): string {
    return sse("update", {
        cursor,
        event: {
            createdAt: 2,
            data: { version: cursor, worklets },
            id: cursor,
            type: "worklets_changed",
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
