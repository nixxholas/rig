import { describe, expect, it } from "vitest";

import { connectRig } from "@/connectRig.js";
import type { GetTimelineResponse } from "@/protocol.js";

const MINUTE = 60_000;
const CURSOR = "01900000-0000-7000-8000-000000000001";

describe("following a timeline", () => {
    it("loads the chart and then keeps it current from the stream", async () => {
        const stream = streamResponse();
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: timelineFetch(stream, () => timeline()),
            randomValues,
            token: "secret",
        });
        const connection = rig.connectTimeline({
            onChange: () => undefined,
            scope: { kind: "session", sessionId: "s" },
        });

        try {
            stream.write(hello(CURSOR, false, false));
            await settle();
            expect(connection.state().connection).toBe("live");
            expect(connection.agents()[0]!.spans).toHaveLength(1);

            stream.write(update("run_started", MINUTE, { runId: "run-1" }));
            await settle();
            stream.write(
                update("run_finished", 3 * MINUTE, { runId: "run-1", stopReason: "stop" }),
            );
            await settle();

            const spans = connection.agents()[0]!.spans;
            expect(spans.map((span) => span.kind)).toEqual(["waiting", "working", "waiting"]);
            expect(spans[1]).toMatchObject({ endedAt: 3 * MINUTE, outcome: "completed" });
            // Everything is milliseconds on the wire; a chart in minutes is the
            // consumer's choice, not something the library rounds away.
            expect(spans[1]!.endedAt! - spans[1]!.startedAt).toBe(2 * MINUTE);
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("reports the interruption and resumes without reloading", async () => {
        const stream = streamResponse();
        let loads = 0;
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: timelineFetch(stream, () => {
                loads += 1;
                return timeline();
            }),
            randomValues,
            token: "secret",
        });
        const states: string[] = [];
        const connection = rig.connectTimeline({
            onChange: (_agents, state) => states.push(state.connection),
            scope: { kind: "session", sessionId: "s" },
        });

        try {
            stream.write(hello(CURSOR, false, false));
            await settle();
            expect(loads).toBe(1);

            // A clean resume replayed everything that was missed, so the chart
            // this client holds is already current.
            stream.write(hello(CURSOR, false, true));
            await settle();

            expect(loads).toBe(1);
            expect(states).toContain("live");
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("rebuilds the chart after a gap, because a missed event may have closed a bar", async () => {
        const stream = streamResponse();
        let loads = 0;
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: timelineFetch(stream, () => {
                loads += 1;
                return loads === 1
                    ? timeline()
                    : timeline([
                          { endedAt: MINUTE, kind: "waiting", outcome: "completed", startedAt: 0 },
                          {
                              endedAt: 5 * MINUTE,
                              kind: "working",
                              outcome: "aborted",
                              runId: "run-1",
                              startedAt: MINUTE,
                          },
                      ]);
            }),
            randomValues,
            token: "secret",
        });
        const connection = rig.connectTimeline({
            onChange: () => undefined,
            scope: { kind: "session", sessionId: "s" },
        });

        try {
            stream.write(hello(CURSOR, false, false));
            await settle();
            stream.write(hello(CURSOR, true, false));
            await settle();

            expect(loads).toBe(2);
            expect(connection.agents()[0]!.spans[1]).toMatchObject({ outcome: "aborted" });
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("loads one chart for two views of the same scope", async () => {
        const stream = streamResponse();
        let loads = 0;
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: timelineFetch(stream, () => {
                loads += 1;
                return timeline();
            }),
            randomValues,
            token: "secret",
        });
        const first = rig.connectTimeline({
            onChange: () => undefined,
            scope: { kind: "session", sessionId: "s" },
        });
        const second = rig.connectTimeline({
            onChange: () => undefined,
            scope: { kind: "session", sessionId: "s" },
        });

        try {
            stream.write(hello(CURSOR, false, false));
            await settle();

            expect(loads).toBe(1);
            expect(second.agents()).toEqual(first.agents());
        } finally {
            first.close();
            second.close();
            rig.close();
        }
    });

    it("asks the daemon for exactly the chart the caller subscribed to", async () => {
        const stream = streamResponse();
        const requests: unknown[] = [];
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: async (input, init) => {
                const url = new URL(String(input));
                if (url.pathname === "/events/live") return stream.response;
                if (url.pathname === "/timeline") {
                    requests.push(JSON.parse(String(init?.body)));
                    return new Response(JSON.stringify(timeline()), { status: 200 });
                }
                throw new Error(`Unexpected request to ${url.pathname}`);
            },
            randomValues,
            token: "secret",
        });
        const connection = rig.connectTimeline({
            includeArchived: true,
            onChange: () => undefined,
            scope: { kind: "workspace", projectId: "p1", workspaceId: "w1" },
            since: 5 * MINUTE,
        });

        try {
            stream.write(hello(CURSOR, false, false));
            await settle();

            expect(requests[0]).toEqual({
                includeArchived: true,
                scope: { kind: "workspace", projectId: "p1", workspaceId: "w1" },
                since: 5 * MINUTE,
            });
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("says it is reconnecting rather than stalling silently", async () => {
        // Each connection gets its own stream, the way a real daemon would answer
        // a reconnect. Handing back one already-consumed response instead would
        // make the retry loop spin rather than exercise the drop.
        const streams = [streamResponse(), streamResponse()];
        let opened = 0;
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: (async (input: RequestInfo | URL) => {
                const url = new URL(String(input));
                if (url.pathname === "/events/live") {
                    const stream = streams[Math.min(opened, streams.length - 1)]!;
                    opened += 1;
                    return stream.response;
                }
                if (url.pathname === "/timeline") {
                    return new Response(JSON.stringify(timeline()), { status: 200 });
                }
                throw new Error(`Unexpected request to ${url.pathname}`);
            }) as typeof fetch,
            randomValues,
            token: "secret",
            wait: async () => undefined,
        });
        const states: string[] = [];
        const connection = rig.connectTimeline({
            onChange: (_agents, state) => states.push(state.connection),
            scope: { kind: "session", sessionId: "s" },
        });

        try {
            streams[0]!.write(hello(CURSOR, false, false));
            await settle();
            streams[0]!.close();
            await settle();

            expect(states).toContain("reconnecting");
        } finally {
            connection.close();
            rig.close();
        }
    });
});

function timelineFetch(
    stream: ReturnType<typeof streamResponse>,
    load: () => GetTimelineResponse,
): typeof fetch {
    return (async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === "/events/live") return stream.response;
        if (url.pathname === "/timeline") {
            return new Response(JSON.stringify(load()), { status: 200 });
        }
        throw new Error(`Unexpected request to ${url.pathname}`);
    }) as typeof fetch;
}

function timeline(spans?: GetTimelineResponse["agents"][number]["spans"]): GetTimelineResponse {
    return {
        agents: [
            {
                agentId: "agent-s",
                createdAt: 0,
                depth: 0,
                label: "Untitled chat",
                modelId: "model",
                scope: { kind: "project", projectId: "p1" },
                providerId: "codex",
                sessionId: "s",
                spans: spans ?? [{ kind: "waiting", startedAt: 0 }],
                type: "primary",
            },
        ],
        cursor: CURSOR,
        scope: { kind: "session", sessionId: "s" },
    };
}

function hello(cursor: string, gap: boolean, resumed: boolean): string {
    return `event: hello\ndata: ${JSON.stringify({ cursor, gap, protocolVersion: 6, resumed })}\n\n`;
}

function update(type: string, createdAt: number, data: unknown): string {
    const frame = {
        cursor: CURSOR,
        event: { createdAt, data, id: CURSOR, projectId: "p1", sessionId: "s", type },
    };
    return `event: update\ndata: ${JSON.stringify(frame)}\n\n`;
}

function streamResponse() {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
        start(next) {
            controller = next;
        },
    });
    return {
        close: () => controller.close(),
        response: new Response(body, { status: 200 }),
        write: (frame: string) => controller.enqueue(encoder.encode(frame)),
    };
}

const randomValues = (bytes: Uint8Array): Uint8Array => {
    bytes.fill(1);
    return bytes;
};

async function settle(): Promise<void> {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
}
