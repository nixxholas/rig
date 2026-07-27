import { describe, expect, it } from "vitest";

import { streamGlobalEvents } from "@/streamGlobalEvents.js";
import type { GlobalStreamHello } from "@/protocol.js";

describe("streamGlobalEvents", () => {
    it("resumes from frames accepted before a transport failure", async () => {
        const controller = new AbortController();
        const attempts: (string | null)[] = [];
        const encoder = new TextEncoder();
        let connection = 0;
        let connectionFrame = 0;
        const hello: GlobalStreamHello = {
            cursor: "10",
            projects: [],
            sessions: [],
            sessionsComplete: true,
            terminalGroups: [],
            workspaces: [],
        };

        await streamGlobalEvents({
            endpoint: "http://daemon.test",
            fetch: (input) => {
                attempts.push(new URL(String(input)).searchParams.get("after"));
                connection += 1;
                if (connection === 1) {
                    return Promise.resolve(
                        new Response(
                            new ReadableStream({
                                pull(stream) {
                                    if (connectionFrame === 0) {
                                        connectionFrame += 1;
                                        stream.enqueue(
                                            encoder.encode(
                                                `event: hello\ndata: ${JSON.stringify(hello)}\n\n`,
                                            ),
                                        );
                                        return;
                                    }
                                    if (connectionFrame === 1) {
                                        connectionFrame += 1;
                                        stream.enqueue(
                                            encoder.encode(
                                                `id: 11\nevent: session_created\ndata: ${JSON.stringify(
                                                    {
                                                        createdAt: 1,
                                                        data: {},
                                                        id: "event-1",
                                                        sessionId: "session-1",
                                                        type: "session_created",
                                                    },
                                                )}\n\n`,
                                            ),
                                        );
                                        return;
                                    }
                                    stream.error(new Error("transport failed"));
                                },
                            }),
                        ),
                    );
                }
                return Promise.resolve(
                    new Response(
                        `event: hello\ndata: ${JSON.stringify({ ...hello, cursor: "11" })}\n\n`,
                    ),
                );
            },
            onDisconnected: () => undefined,
            onEvent: () => undefined,
            onHello: () => {
                if (connection === 2) controller.abort();
            },
            signal: controller.signal,
            token: "secret",
            wait: () => Promise.resolve(),
        });

        expect(attempts).toEqual([null, "11"]);
    });
});
