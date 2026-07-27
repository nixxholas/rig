import { describe, expect, it } from "vitest";

import { SessionStreamRefused, streamSessionEvents } from "@/streamSessionEvents.js";
import type { SessionEvent, SessionStreamHello } from "@/protocol.js";

function sse(frames: readonly string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
        start(controller) {
            for (const frame of frames) controller.enqueue(encoder.encode(frame));
            controller.close();
        },
    });
}

function helloFrame(resumed: boolean, lastEventId?: string): string {
    const hello: SessionStreamHello = {
        activity: { kind: "idle", label: "Idle", since: 0 },
        ...(lastEventId === undefined ? {} : { lastEventId }),
        resumed,
    };
    return `event: hello\ndata: ${JSON.stringify(hello)}\n\n`;
}

function eventFrame(id: string): string {
    const event = {
        createdAt: 1,
        data: { runId: "run-1" },
        id,
        sessionId: "session-1",
        type: "run_started",
    };
    return `id: ${id}\nevent: run_started\ndata: ${JSON.stringify(event)}\n\n`;
}

interface Attempt {
    after: string | null;
}

/** Serves each scripted connection in turn and records what was requested. */
function scriptedFetch(bodies: readonly (readonly string[])[], attempts: Attempt[]) {
    let index = 0;
    return (input: string | URL | Request): Promise<Response> => {
        const url = new URL(String(input));
        attempts.push({ after: url.searchParams.get("after") });
        const body = bodies[Math.min(index, bodies.length - 1)] ?? [];
        index += 1;
        return Promise.resolve(
            new Response(sse(body), {
                headers: { "content-type": "text/event-stream" },
                status: 200,
            }),
        );
    };
}

describe("streamSessionEvents", () => {
    it("delivers the hello frame apart from session events", async () => {
        const controller = new AbortController();
        const attempts: Attempt[] = [];
        const events: SessionEvent[] = [];
        const hellos: SessionStreamHello[] = [];

        await streamSessionEvents({
            endpoint: "http://daemon.test",
            sessionId: "session-1",
            signal: controller.signal,
            token: "secret",
            fetch: scriptedFetch([[helloFrame(false), eventFrame("event-1")]], attempts),
            onHello: (hello) => hellos.push(hello),
            onEvent: (event) => {
                events.push(event);
                controller.abort();
            },
            onDisconnected: () => undefined,
            wait: () => Promise.resolve(),
        });

        expect(hellos).toHaveLength(1);
        expect(events.map((event) => event.id)).toEqual(["event-1"]);
    });

    it("resumes from the last event it delivered rather than restarting", async () => {
        const controller = new AbortController();
        const attempts: Attempt[] = [];
        let delivered = 0;

        await streamSessionEvents({
            endpoint: "http://daemon.test",
            sessionId: "session-1",
            signal: controller.signal,
            token: "secret",
            fetch: scriptedFetch(
                [
                    [helloFrame(false), eventFrame("event-1")],
                    [helloFrame(true), eventFrame("event-2")],
                ],
                attempts,
            ),
            onHello: () => undefined,
            onEvent: () => {
                delivered += 1;
                if (delivered === 2) controller.abort();
            },
            onDisconnected: () => undefined,
            wait: () => Promise.resolve(),
        });

        expect(attempts).toEqual([{ after: null }, { after: "event-1" }]);
    });

    it("does not skip catch-up when a resumed stream drops after its hello", async () => {
        const controller = new AbortController();
        const attempts: Attempt[] = [];
        let delivered = 0;

        await streamSessionEvents({
            endpoint: "http://daemon.test",
            sessionId: "session-1",
            signal: controller.signal,
            token: "secret",
            fetch: scriptedFetch(
                [
                    [helloFrame(false), eventFrame("event-1")],
                    [helloFrame(true, "event-3")],
                    [helloFrame(true), eventFrame("event-2")],
                ],
                attempts,
            ),
            onHello: () => undefined,
            onEvent: () => {
                delivered += 1;
                if (delivered === 2) controller.abort();
            },
            onDisconnected: () => undefined,
            wait: () => Promise.resolve(),
        });

        expect(attempts).toEqual([{ after: null }, { after: "event-1" }, { after: "event-1" }]);
    });

    it("resumes a quiet stream from the cursor covered by its hello frame", async () => {
        const controller = new AbortController();
        const attempts: Attempt[] = [];
        let connections = 0;

        await streamSessionEvents({
            endpoint: "http://daemon.test",
            sessionId: "session-1",
            signal: controller.signal,
            token: "secret",
            fetch: scriptedFetch(
                [[helloFrame(false, "event-in-hello")], [helloFrame(true)]],
                attempts,
            ),
            onHello: () => {
                connections += 1;
                if (connections === 2) controller.abort();
            },
            onEvent: () => undefined,
            onDisconnected: () => undefined,
            wait: () => Promise.resolve(),
        });

        expect(attempts).toEqual([{ after: null }, { after: "event-in-hello" }]);
    });

    it("reports every disconnection to the subscriber", async () => {
        const controller = new AbortController();
        const attempts: Attempt[] = [];
        let disconnections = 0;

        await streamSessionEvents({
            endpoint: "http://daemon.test",
            sessionId: "session-1",
            signal: controller.signal,
            token: "secret",
            fetch: scriptedFetch([[helloFrame(false)]], attempts),
            onHello: () => undefined,
            onEvent: () => undefined,
            onDisconnected: () => {
                disconnections += 1;
                if (disconnections === 2) controller.abort();
            },
            wait: () => Promise.resolve(),
        });

        expect(disconnections).toBe(2);
    });

    it("stops instead of retrying when the daemon refuses the request", async () => {
        const controller = new AbortController();

        await expect(
            streamSessionEvents({
                endpoint: "http://daemon.test",
                sessionId: "session-1",
                signal: controller.signal,
                token: "secret",
                fetch: () => Promise.resolve(new Response("no", { status: 409 })),
                onHello: () => undefined,
                onEvent: () => undefined,
                onDisconnected: () => undefined,
                wait: () => Promise.resolve(),
            }),
        ).rejects.toBeInstanceOf(SessionStreamRefused);
    });

    it("sends the token and asks for an event stream", async () => {
        const controller = new AbortController();
        let headers: Headers | undefined;

        await streamSessionEvents({
            endpoint: "http://daemon.test",
            sessionId: "session-1",
            signal: controller.signal,
            token: "secret",
            fetch: (_input, init) => {
                headers = new Headers(init?.headers);
                controller.abort();
                return Promise.resolve(new Response(sse([helloFrame(false)]), { status: 200 }));
            },
            onHello: () => undefined,
            onEvent: () => undefined,
            onDisconnected: () => undefined,
            wait: () => Promise.resolve(),
        });

        expect(headers?.get("authorization")).toBe("Bearer secret");
        expect(headers?.get("accept")).toBe("text/event-stream");
    });

    it("reassembles a frame split across chunks and ignores keepalives", async () => {
        const controller = new AbortController();
        const events: SessionEvent[] = [];
        const frame = eventFrame("event-1");

        await streamSessionEvents({
            endpoint: "http://daemon.test",
            sessionId: "session-1",
            signal: controller.signal,
            token: "secret",
            fetch: () =>
                Promise.resolve(
                    new Response(
                        sse([
                            ": connected\n\n",
                            helloFrame(false),
                            ": keepalive\n\n",
                            frame.slice(0, 20),
                            frame.slice(20),
                        ]),
                        { status: 200 },
                    ),
                ),
            onHello: () => undefined,
            onEvent: (event) => {
                events.push(event);
                controller.abort();
            },
            onDisconnected: () => undefined,
            wait: () => Promise.resolve(),
        });

        expect(events.map((event) => event.id)).toEqual(["event-1"]);
    });
    it("reads frames delimited the way the spec allows, not only with newlines", async () => {
        const controller = new AbortController();
        const events: SessionEvent[] = [];
        let hello: SessionStreamHello | undefined;

        // A proxy or server that emits CRLF is producing valid Server-Sent
        // Events, so a client that only understands "\n\n" would stall on it.
        await streamSessionEvents({
            endpoint: "http://daemon.test",
            sessionId: "session-1",
            signal: controller.signal,
            token: "secret",
            fetch: onceThenStop(controller, [
                helloFrame(false).replace(/\n/g, "\r\n"),
                eventFrame("event-1").replace(/\n/g, "\r\n"),
            ]),
            onHello: (frame) => {
                hello = frame;
            },
            onEvent: (event) => {
                events.push(event);
                controller.abort();
            },
            onDisconnected: () => undefined,
            wait: () => Promise.resolve(),
        });

        expect(hello?.resumed).toBe(false);
        expect(events.map((event) => event.id)).toEqual(["event-1"]);
    });

    it("delivers a final frame that arrives without a trailing blank line", async () => {
        const controller = new AbortController();
        const events: SessionEvent[] = [];

        // A stream cut off after its last frame still carries a complete event,
        // and dropping it would lose an event the daemon considers delivered.
        await streamSessionEvents({
            endpoint: "http://daemon.test",
            sessionId: "session-1",
            signal: controller.signal,
            token: "secret",
            fetch: onceThenStop(controller, [
                helloFrame(false),
                eventFrame("event-1").replace(/\n\n$/, ""),
            ]),
            onHello: () => undefined,
            onEvent: (event) => {
                events.push(event);
                controller.abort();
            },
            onDisconnected: () => undefined,
            wait: () => Promise.resolve(),
        });

        expect(events.map((event) => event.id)).toEqual(["event-1"]);
    });

    it("recovers by attaching fresh when its cursor is too old to resume from", async () => {
        const controller = new AbortController();
        const attempts: Attempt[] = [];
        const events: SessionEvent[] = [];
        const hellos: SessionStreamHello[] = [];
        let call = 0;

        await streamSessionEvents({
            endpoint: "http://daemon.test",
            sessionId: "session-1",
            signal: controller.signal,
            token: "secret",
            fetch: (input: string | URL | Request) => {
                attempts.push({ after: new URL(String(input)).searchParams.get("after") });
                call += 1;
                if (call === 1) {
                    return Promise.resolve(
                        new Response(sse([helloFrame(false), eventFrame("event-1")]), {
                            status: 200,
                        }),
                    );
                }
                // The daemon no longer holds the cursor. Refusing forever would
                // strand the client on a session it can still be shown.
                if (call === 2) {
                    return Promise.resolve(
                        new Response(JSON.stringify({ error: "Event cursor not found" }), {
                            status: 409,
                        }),
                    );
                }
                if (call > 3) {
                    controller.abort();
                    return Promise.resolve(new Response(sse([]), { status: 200 }));
                }
                return Promise.resolve(
                    new Response(sse([helloFrame(false), eventFrame("event-2")]), { status: 200 }),
                );
            },
            onHello: (frame) => hellos.push(frame),
            onEvent: (event) => {
                events.push(event);
                if (event.id === "event-2") controller.abort();
            },
            onDisconnected: () => undefined,
            wait: () => Promise.resolve(),
        });

        // The retry after the refusal drops the cursor, so the daemon answers
        // with a fresh snapshot instead of a gap.
        expect(attempts.map((attempt) => attempt.after)).toEqual([null, "event-1", null]);
        expect(events.map((event) => event.id)).toEqual(["event-1", "event-2"]);
        expect(hellos).toHaveLength(2);
    });

    it("still gives up when the daemon refuses for a reason a retry cannot fix", async () => {
        const controller = new AbortController();

        await expect(
            streamSessionEvents({
                endpoint: "http://daemon.test",
                sessionId: "session-1",
                signal: controller.signal,
                token: "secret",
                fetch: () => Promise.resolve(new Response("no", { status: 403 })),
                onHello: () => undefined,
                onEvent: () => undefined,
                onDisconnected: () => undefined,
                wait: () => Promise.resolve(),
            }),
        ).rejects.toBeInstanceOf(SessionStreamRefused);
    });
});

/**
 * Serves one scripted connection, then ends the loop.
 *
 * A reconnect means the first connection did not deliver what the test expected,
 * so the run stops and the assertion reports it. Without this a regression makes
 * the test hang instead of fail.
 */
function onceThenStop(controller: AbortController, body: readonly string[]) {
    let served = false;
    return (): Promise<Response> => {
        if (served) {
            controller.abort();
            return Promise.resolve(new Response(sse([]), { status: 200 }));
        }
        served = true;
        return Promise.resolve(new Response(sse(body), { status: 200 }));
    };
}
