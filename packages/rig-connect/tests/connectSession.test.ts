import { describe, expect, it } from "vitest";

import { connectSession } from "@/connectSession.js";
import type { ChatDelta, ChatElement, SessionState } from "@/ChatElement.js";
import type {
    Message,
    SessionEvent,
    SessionStreamHello,
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
    return {
        requests,
        fetch: (input: string | URL | Request) => {
            requests.push(new URL(String(input)));
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

function helloFrame(): string {
    const hello: SessionStreamHello = {
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
            snapshot: { messages: [] },
            status: "idle",
            tasks: [],
        },
    };
    return `event: hello\ndata: ${JSON.stringify(hello)}\n\n`;
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

function pagedHelloFrame(): string {
    const transcript = transcriptWindow(4, false);
    const hello: SessionStreamHello = {
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
            snapshot: { messages: transcript.messages },
            status: "idle",
            tasks: [],
        },
        transcript,
    };
    return `event: hello\ndata: ${JSON.stringify(hello)}\n\n`;
}

function frame(event: Partial<SessionEvent> & { type: string }): string {
    const full = { createdAt: 1, data: {}, id: "event-1", sessionId: "session-1", ...event };
    return `id: ${full.id}\nevent: ${full.type}\ndata: ${JSON.stringify(full)}\n\n`;
}

async function settle(): Promise<void> {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("connectSession", () => {
    it("renders a conversation from the stream alone, without a follow-up request", async () => {
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
            stream.write(helloFrame());
            stream.write(frame({ data: { runId: "run-1" }, id: "e1", type: "run_started" }));
            stream.write(
                frame({
                    data: {
                        message: {
                            blocks: [{ text: "Hello.", type: "text" }],
                            id: "m1",
                            role: "agent",
                        },
                        runId: "run-1",
                    },
                    id: "e2",
                    type: "agent_message",
                }),
            );
            stream.write(
                frame({
                    data: { runId: "run-1", stopReason: "stop" },
                    id: "e3",
                    type: "run_finished",
                }),
            );
            await settle();

            expect(connection.elements().map((element) => element.kind)).toEqual([
                "agent_text",
                "turn_end",
            ]);
            expect(connection.session()).toMatchObject({ connection: "live", modelId: "sonnet-5" });
            // One stream, and nothing else: the whole conversation came from it.
            expect(stream.requests).toHaveLength(1);
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
            stream.write(helloFrame());
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
            stream.write(helloFrame());
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

        stream.write(helloFrame());
        await settle();
        const before = renders;

        connection.close();
        stream.write(frame({ data: { runId: "run-1" }, id: "e1", type: "run_started" }));
        await settle();

        expect(renders).toBe(before);
    });

    it.each(["session_reset", "session_rewound"] as const)(
        "discards an earlier page that arrives after %s",
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
                stream.write(pagedHelloFrame());
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

                expect(connection.elements()).toEqual([]);
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
