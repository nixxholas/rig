import { describe, expect, it } from "vitest";

import { connectSession } from "@/connectSession.js";
import type { ChatDelta, ChatElement, SessionState } from "@/ChatElement.js";
import type {
    Message,
    SessionEvent,
    SessionStateResponse,
    SessionTranscriptWindow,
} from "@/protocol.js";

/** A stream the test feeds frame by frame, standing in for a live daemon. */
function controllableStream() {
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const requests: URL[] = [];
    const body = new ReadableStream<Uint8Array>({
        start(streamController) {
            controller = streamController;
        },
    });
    let state: unknown = sessionStateBody(false);
    return {
        requests,
        /** Replaces what a bootstrap of this session reports. */
        setState(next: unknown) {
            state = next;
        },
        fetch: (input: string | URL | Request) => {
            const url = new URL(String(input));
            requests.push(url);
            if (url.pathname.endsWith("/state")) {
                return Promise.resolve(new Response(JSON.stringify(state), { status: 200 }));
            }
            return Promise.resolve(new Response(body, { status: 200 }));
        },
        write(frame: string) {
            controller?.enqueue(encoder.encode(frame));
        },
        close() {
            controller?.close();
        },
    };
}

function liveHello(): string {
    return `event: hello\ndata: ${JSON.stringify({
        cursor: "01900000-0000-7000-8000-000000000001",
        gap: false,
        resumed: false,
    })}\n\n`;
}

function sessionStateBody(paged: boolean): SessionStateResponse {
    const transcript = paged ? transcriptWindow(4, false) : undefined;
    const hello: SessionStateResponse = {
        cursor: "01900000-0000-7000-8000-000000000001",
        activity: { kind: "idle", label: "Idle", since: 0 },
        resumed: false,
        session: {
            activity: { kind: "idle", label: "Idle", since: 0 },
            archived: false,
            cwd: "/work",
            id: "session-1",
            modelLocked: false,
            modelId: "sonnet-5",
            models: [],
            orderKey: "a0",
            pendingUserInputs: [],
            permissionMode: "auto",
            projectId: "project-1",
            providerId: "claude",
            snapshot: { messages: transcript?.messages ?? [] },
            status: "idle",
            tasks: [],
        },
        ...(transcript === undefined ? {} : { transcript }),
    };
    return hello;
}

function transcriptWindow(run: number, complete: boolean): SessionTranscriptWindow {
    const messages = [
        {
            blocks: [{ text: `User ${String(run)}`, type: "text" }],
            id: `u${String(run)}`,
            role: "user",
        },
        {
            blocks: [{ text: `Agent ${String(run)}`, type: "text" }],
            id: `a${String(run)}`,
            role: "agent",
        },
    ] as Message[];
    return {
        complete,
        messages,
        turns: [
            {
                endedAt: run * 100 + 50,
                messageIds: messages.map((message) => message.id),
                outcome: "success",
                runId: `run-${String(run)}`,
                startedAt: run * 100,
            },
        ],
    };
}

function frame(
    event: Partial<SessionEvent> & { type: string },
    cursor = event.id ?? "event-1",
): string {
    const full = { createdAt: 1, data: {}, id: "event-1", sessionId: "session-1", ...event };
    return `id: ${cursor}\nevent: update\ndata: ${JSON.stringify({
        cursor,
        event: full,
    })}\n\n`;
}

async function settle(): Promise<void> {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("connectSession", () => {
    it("renders a conversation from one global stream plus one bootstrap", async () => {
        const stream = controllableStream();
        const renders: { elements: readonly ChatElement[]; session: SessionState }[] = [];
        const connection = connectSession({
            endpoint: "http://daemon.test",
            fetch: stream.fetch,
            onChange: (elements, session) => renders.push({ elements, session }),
            sessionId: "session-1",
            token: "secret",
        });

        try {
            stream.write(liveHello());
            // Stream cursors and session event ids are distinct UUID sequences.
            // These event ids deliberately sort before the snapshot's stream
            // cursor, while their delivery cursors sort after it.
            stream.write(
                frame(
                    {
                        data: { runId: "run-1" },
                        id: "00000000-0000-7000-8000-000000000001",
                        type: "run_started",
                    },
                    "01900000-0000-7000-8000-000000000002",
                ),
            );
            stream.write(
                frame(
                    {
                        data: {
                            message: {
                                blocks: [{ text: "Hello.", type: "text" }],
                                id: "m1",
                                role: "agent",
                            },
                            runId: "run-1",
                        },
                        id: "00000000-0000-7000-8000-000000000002",
                        type: "agent_message",
                    },
                    "01900000-0000-7000-8000-000000000003",
                ),
            );
            stream.write(
                frame(
                    {
                        data: { runId: "run-1", stopReason: "stop" },
                        id: "00000000-0000-7000-8000-000000000003",
                        type: "run_finished",
                    },
                    "01900000-0000-7000-8000-000000000004",
                ),
            );
            await settle();

            expect(connection.elements().map((element) => element.kind)).toEqual([
                "agent_text",
                "turn_end",
            ]);
            expect(connection.session()).toMatchObject({ connection: "live", modelId: "sonnet-5" });
            // One subscription, and one bootstrap. The stream carries no session
            // object, so the chat is fetched once and followed from then on; what
            // matters is that no session-scoped stream was opened.
            expect(stream.requests.map((url) => url.pathname)).toEqual([
                "/events/live",
                "/sessions/session-1/state",
            ]);
        } finally {
            connection.close();
        }
    });

    it("hands over the list before the deltas that describe it", async () => {
        const stream = controllableStream();
        const order: string[] = [];
        const deltas: ChatDelta[] = [];
        const connection = connectSession({
            endpoint: "http://daemon.test",
            fetch: stream.fetch,
            onChange: () => order.push("change"),
            onDelta: (delta) => {
                order.push(`delta:${delta.type}`);
                deltas.push(delta);
            },
            sessionId: "session-1",
            token: "secret",
        });

        try {
            stream.write(liveHello());
            stream.write(frame({ data: { runId: "run-1" }, id: "e1", type: "run_started" }));
            await settle();

            expect(order[0]).toBe("change");
            expect(deltas.map((delta) => delta.type)).toContain("turn_started");
        } finally {
            connection.close();
        }
    });

    it("reports the connection state to the subscriber", async () => {
        const stream = controllableStream();
        const states: string[] = [];
        const connection = connectSession({
            endpoint: "http://daemon.test",
            fetch: stream.fetch,
            onChange: (_elements, session) => states.push(session.connection),
            sessionId: "session-1",
            token: "secret",
        });

        try {
            stream.write(liveHello());
            await settle();
            expect(states.at(-1)).toBe("live");
        } finally {
            connection.close();
        }
    });

    it("releases everything on close and stops reporting", async () => {
        const stream = controllableStream();
        let renders = 0;
        const connection = connectSession({
            endpoint: "http://daemon.test",
            fetch: stream.fetch,
            onChange: () => {
                renders += 1;
            },
            sessionId: "session-1",
            token: "secret",
        });

        stream.write(liveHello());
        await settle();
        const before = renders;

        connection.close();
        stream.write(frame({ data: { runId: "run-1" }, id: "e1", type: "run_started" }));
        await settle();

        expect(renders).toBe(before);
    });

    it.each(["session_reset", "session_rewound"] as const)(
        "keeps immutable turns and discards an earlier page that arrives after %s",
        async (type) => {
            const stream = controllableStream();
            let resolvePage: ((response: Response) => void) | undefined;
            const page = new Promise<Response>((resolve) => {
                resolvePage = resolve;
            });
            const connection = connectSession({
                endpoint: "http://daemon.test",
                fetch: (input) =>
                    new URL(String(input)).pathname.endsWith("/transcript")
                        ? page
                        : stream.fetch(input),
                onChange: () => undefined,
                sessionId: "session-1",
                token: "secret",
            });

            try {
                stream.setState(sessionStateBody(true));
                stream.write(liveHello());
                await settle();
                const token = connection.session().loadMoreToken;
                if (token === undefined) throw new Error("Expected a load-more token.");
                expect(connection.loadMore(token)).toBeUndefined();
                // A rendering race with the same token must not issue another request.
                expect(connection.loadMore(token)).toBeUndefined();
                await settle();

                stream.write(
                    frame({
                        data: {
                            ...(type === "session_rewound" ? { messageId: "u4" } : {}),
                            snapshot: { messages: [] },
                            transcript: { complete: true, messages: [], turns: [] },
                        },
                        id: "replacement",
                        type,
                    }),
                );
                await settle();
                resolvePage?.(
                    new Response(JSON.stringify(transcriptWindow(1, true)), { status: 200 }),
                );
                await settle();

                expect(new Set(connection.elements().map((element) => element.turnId))).toEqual(
                    new Set(["run-4"]),
                );
                expect(connection.session()).toMatchObject({
                    loadingMore: false,
                    transcriptComplete: true,
                });
            } finally {
                connection.close();
            }
        },
    );
});
