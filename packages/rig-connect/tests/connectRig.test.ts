import { describe, expect, it, vi } from "vitest";

import type { ChatDelta } from "@/ChatElement.js";
import { connectRig } from "@/connectRig.js";
import type { GlobalStreamHello, SessionStreamHello } from "@/protocol.js";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
    });
    return { promise, reject, resolve };
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

function hello(modelId = "old-model"): string {
    const value: SessionStreamHello = {
        activity: { kind: "idle", label: "Idle", since: 1 },
        lastEventId: "01900000-0000-7000-8000-000000000001",
        resumed: false,
        session: {
            activity: { kind: "idle", label: "Idle", since: 1 },
            archived: false,
            cwd: "/work",
            id: "session-1",
            lastEventId: "01900000-0000-7000-8000-000000000001",
            modelLocked: false,
            modelId,
            models: [],
            orderKey: "a",
            pendingUserInputs: [],
            permissionMode: "auto",
            projectId: "project-1",
            providerId: "codex",
            snapshot: { messages: [] },
            status: "idle",
            tasks: [],
        },
    };
    return `event: hello\ndata: ${JSON.stringify(value)}\n\n`;
}

function groupsHello(): string {
    const value: GlobalStreamHello = {
        cursor: "global-1",
        projects: [
            {
                createdAt: 1,
                id: "project-1",
                initializationStatus: "ready",
                kind: "regular",
                name: "Before",
                nameSource: "folder",
                orderKey: "a",
                path: "/work",
                presence: "present",
                updatedAt: 1,
                version: 3,
                worktreeSupport: "supported",
            },
        ],
        sessions: [],
        sessionsComplete: true,
        terminalGroups: [],
        workspaces: [],
    };
    return `event: hello\ndata: ${JSON.stringify(value)}\n\n`;
}

function event(
    type: string,
    data: Record<string, unknown>,
    id = "01900000-0000-7000-8000-000000000002",
): string {
    return `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify({
        createdAt: 2,
        data,
        id,
        sessionId: "session-1",
        type,
    })}\n\n`;
}

async function settle(): Promise<void> {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
}

const randomValues = (bytes: Uint8Array): Uint8Array => {
    bytes.fill(1);
    return bytes;
};

describe("connectRig mutations", () => {
    it("uses client-selected identities for retry-safe create and fork", async () => {
        const stream = streamResponse();
        const calls: { init?: RequestInit; url: URL }[] = [];
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: (input, init) => {
                const url = new URL(String(input));
                calls.push({ ...(init === undefined ? {} : { init }), url });
                return Promise.resolve(
                    url.pathname.endsWith("/stream")
                        ? stream.response
                        : new Response("{}", { status: 200 }),
                );
            },
            now: () => 1_700_000_000_000,
            randomValues,
            token: "secret",
        });
        const connection = rig.connectSession({
            onChange: () => undefined,
            sessionId: "session-1",
        });
        try {
            stream.write(hello());
            await settle();
            const createdId = rig.createSession({ cwd: "/new-work" });
            const forkedId = rig.forkSession("session-1");
            expect(createdId).not.toBe(forkedId);
            await settle();

            const createCall = calls.find(
                (call) => call.url.pathname === "/sessions" && call.init?.method === "POST",
            );
            expect(JSON.parse(String(createCall?.init?.body))).toMatchObject({
                clientSessionId: createdId,
                cwd: "/new-work",
                mutationId: createdId,
            });
            const forkCall = calls.find((call) => call.url.pathname.endsWith("/fork"));
            expect(forkCall?.init?.headers).toMatchObject({
                "x-rig-mutation-id": forkedId,
            });
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("applies the expanded session actions synchronously and delivers them FIFO", async () => {
        const stream = streamResponse();
        const calls: { init?: RequestInit; url: URL }[] = [];
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: (input, init) => {
                const url = new URL(String(input));
                calls.push({ ...(init === undefined ? {} : { init }), url });
                return Promise.resolve(
                    url.pathname.endsWith("/stream")
                        ? stream.response
                        : new Response("{}", { status: 200 }),
                );
            },
            now: () => 1_700_000_000_000,
            randomValues,
            token: "secret",
        });
        const connection = rig.connectSession({
            onChange: () => undefined,
            sessionId: "session-1",
        });
        try {
            stream.write(hello());
            await settle();
            stream.write(
                event("user_input_requested", {
                    questions: [],
                    requestId: "question-1",
                }),
            );
            await settle();

            rig.setEffort("session-1", "high");
            expect(connection.session().effort).toBe("high");
            rig.setServiceTier("session-1", "priority");
            expect(connection.session().serviceTier).toBe("priority");
            rig.setPermissionMode("session-1", "full_access");
            expect(connection.session().permissionMode).toBe("full_access");
            rig.setDraft("session-1", "unfinished thought");
            expect(connection.session().draft).toBe("unfinished thought");
            rig.answerUserInput("session-1", "question-1", { answers: {} });
            expect(connection.session().pendingUserInputs).toEqual([]);
            rig.setGoal("session-1", "Ship the connector");
            expect(connection.session().goal?.objective).toBe("Ship the connector");
            rig.attachSecret("session-1", "secret-1");
            expect(connection.session().sessionSecretIds).toEqual(["secret-1"]);
            rig.runShellCommand("session-1", { command: "pwd", commandId: "shell-1" });
            expect(connection.session().shellCommands).toEqual([
                { command: "pwd", commandId: "shell-1", status: "running" },
            ]);

            await settle();
            expect(
                calls
                    .filter((call) => !call.url.pathname.endsWith("/stream"))
                    .map((call) => `${call.init?.method} ${call.url.pathname}`),
            ).toEqual([
                "PATCH /sessions/session-1/effort",
                "PATCH /sessions/session-1/service-tier",
                "PATCH /sessions/session-1/permissions",
                "PUT /sessions/session-1/draft",
                "POST /sessions/session-1/user-input/question-1",
                "POST /sessions/session-1/goal",
                "POST /sessions/session-1/secrets",
                "POST /sessions/session-1/shell",
            ]);
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("shows a sent message synchronously and reuses one session stream", async () => {
        const stream = streamResponse();
        const calls: { init?: RequestInit; url: URL }[] = [];
        const fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
            const url = new URL(String(input));
            calls.push({ ...(init === undefined ? {} : { init }), url });
            if (url.pathname.endsWith("/stream")) {
                return Promise.resolve(stream.response);
            }
            return Promise.resolve(
                new Response(JSON.stringify({ eventId: "event-send" }), { status: 202 }),
            );
        });
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch,
            now: () => 1_700_000_000_000,
            randomValues,
            token: "secret",
        });
        const first = rig.connectSession({
            onChange: () => undefined,
            sessionId: "session-1",
        });
        const second = rig.connectSession({
            onChange: () => undefined,
            sessionId: "session-1",
        });

        try {
            stream.write(hello());
            await settle();
            const mutationId = rig.sendMessage("session-1", "Visible now");

            expect(typeof mutationId).toBe("string");
            expect(first.elements().at(-1)).toMatchObject({
                kind: "user_message",
                messageId: mutationId,
                text: "Visible now",
            });
            expect(second.elements()).toBe(first.elements());
            expect(calls.filter((call) => call.url.pathname.endsWith("/stream"))).toHaveLength(1);
            const sent = calls.find((call) => call.url.pathname.endsWith("/messages"));
            expect(JSON.parse(String(sent?.init?.body))).toMatchObject({
                clientSubmissionId: mutationId,
                mutationId,
                text: "Visible now",
            });
            expect((sent?.init?.headers as Record<string, string>)["if-match"]).toBe(
                '"01900000-0000-7000-8000-000000000001"',
            );
        } finally {
            first.close();
            second.close();
            rig.close();
        }
    });

    it("retries a lost response with the same mutation identity", async () => {
        const stream = streamResponse();
        const bodies: Record<string, unknown>[] = [];
        let attempts = 0;
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: (input, init) => {
                const url = new URL(String(input));
                if (url.pathname.endsWith("/stream")) return Promise.resolve(stream.response);
                bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
                attempts += 1;
                return attempts === 1
                    ? Promise.reject(new TypeError("response lost"))
                    : Promise.resolve(
                          new Response(JSON.stringify({ eventId: "accepted" }), { status: 202 }),
                      );
            },
            randomValues,
            token: "secret",
            wait: () => Promise.resolve(),
        });
        const connection = rig.connectSession({
            onChange: () => undefined,
            sessionId: "session-1",
        });
        try {
            stream.write(hello());
            await settle();
            rig.sendMessage("session-1", "Once");
            await settle();
            expect(attempts).toBe(2);
            expect(bodies[0]?.mutationId).toBe(bodies[1]?.mutationId);
            expect(bodies[0]?.clientSubmissionId).toBe(bodies[1]?.clientSubmissionId);
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("treats a stale-precondition response as success when Rig already has the intent", async () => {
        const stream = streamResponse();
        const deltas: ChatDelta[] = [];
        let attempts = 0;
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: (input) => {
                const url = new URL(String(input));
                if (url.pathname.endsWith("/stream")) return Promise.resolve(stream.response);
                attempts += 1;
                return attempts === 1
                    ? Promise.reject(new TypeError("response lost"))
                    : Promise.resolve(
                          new Response(
                              JSON.stringify({
                                  error: "The session changed.",
                                  session: {
                                      lastEventId: "accepted",
                                      modelId: "new-model",
                                      providerId: "codex",
                                  },
                              }),
                              { status: 409 },
                          ),
                      );
            },
            randomValues,
            token: "secret",
            wait: () => Promise.resolve(),
        });
        const connection = rig.connectSession({
            onChange: () => undefined,
            onDelta: (delta) => deltas.push(delta),
            sessionId: "session-1",
        });
        try {
            stream.write(hello());
            await settle();
            rig.switchModel("session-1", "new-model");
            await settle();

            expect(attempts).toBe(2);
            expect(connection.session().modelId).toBe("new-model");
            expect(deltas.some((delta) => delta.type === "mutation_rejected")).toBe(false);
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("keeps a successful session prediction when HTTP wins the race with SSE", async () => {
        const stream = streamResponse();
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: (input) => {
                const url = new URL(String(input));
                if (url.pathname.endsWith("/stream")) return Promise.resolve(stream.response);
                return Promise.resolve(
                    new Response(
                        JSON.stringify({
                            session: {
                                activity: { kind: "idle", label: "Idle", since: 2 },
                                archived: false,
                                cwd: "/work",
                                id: "session-1",
                                lastEventId: "01900000-0000-7000-8000-000000000002",
                                modelLocked: false,
                                modelId: "new-model",
                                models: [],
                                orderKey: "a",
                                pendingUserInputs: [],
                                permissionMode: "auto",
                                projectId: "project-1",
                                providerId: "codex",
                                snapshot: { messages: [] },
                                status: "idle",
                                tasks: [],
                            },
                        }),
                        { status: 200 },
                    ),
                );
            },
            randomValues,
            token: "secret",
        });
        const connection = rig.connectSession({
            onChange: () => undefined,
            sessionId: "session-1",
        });
        try {
            stream.write(hello());
            await settle();
            rig.switchModel("session-1", "new-model");
            expect(connection.session().modelId).toBe("new-model");
            await settle();
            expect(connection.session().modelId).toBe("new-model");
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("keeps same-session actions FIFO while unrelated sessions run in parallel", async () => {
        const streams = new Map<string, ReturnType<typeof streamResponse>>();
        const requests: { body: { modelId: string }; sessionId: string }[] = [];
        const responses: ReturnType<typeof deferred<Response>>[] = [];
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: (input, init) => {
                const url = new URL(String(input));
                const sessionId = url.pathname.split("/")[2] ?? "";
                if (url.pathname.endsWith("/stream")) {
                    const stream = streamResponse();
                    streams.set(sessionId, stream);
                    return Promise.resolve(stream.response);
                }
                const pending = deferred<Response>();
                responses.push(pending);
                requests.push({
                    body: JSON.parse(String(init?.body)) as { modelId: string },
                    sessionId,
                });
                return pending.promise;
            },
            randomValues,
            token: "secret",
        });
        const one = rig.connectSession({ onChange: () => undefined, sessionId: "one" });
        const two = rig.connectSession({ onChange: () => undefined, sessionId: "two" });
        try {
            rig.switchModel("one", "model-a");
            rig.switchModel("one", "model-b");
            rig.switchModel("two", "model-c");
            await settle();

            expect(requests).toEqual([
                { body: expect.objectContaining({ modelId: "model-a" }), sessionId: "one" },
                { body: expect.objectContaining({ modelId: "model-c" }), sessionId: "two" },
            ]);

            responses[0]?.resolve(
                new Response(JSON.stringify({ session: { lastEventId: "one-next" } }), {
                    status: 200,
                }),
            );
            await settle();
            expect(requests.at(-1)).toEqual({
                body: expect.objectContaining({ modelId: "model-b" }),
                sessionId: "one",
            });
        } finally {
            one.close();
            two.close();
            rig.close();
        }
    });

    it("rolls back a rejected change and reapplies the later optimistic overlay", async () => {
        const stream = streamResponse();
        const second = deferred<Response>();
        let mutations = 0;
        const deltas: ChatDelta[] = [];
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: (input) => {
                const url = new URL(String(input));
                if (url.pathname.endsWith("/stream")) return Promise.resolve(stream.response);
                mutations += 1;
                return mutations === 1
                    ? Promise.resolve(
                          new Response(JSON.stringify({ error: "That model is unavailable." }), {
                              status: 400,
                          }),
                      )
                    : second.promise;
            },
            randomValues,
            token: "secret",
        });
        const connection = rig.connectSession({
            onChange: () => undefined,
            onDelta: (delta) => deltas.push(delta),
            sessionId: "session-1",
        });
        try {
            stream.write(hello());
            await settle();
            const rejected = rig.switchModel("session-1", "model-a");
            rig.switchModel("session-1", "model-b");
            expect(connection.session().modelId).toBe("model-b");
            await settle();

            expect(connection.session().modelId).toBe("model-b");
            expect(deltas).toContainEqual({
                action: "switch_model",
                message: "That model is unavailable.",
                mutationId: rejected,
                type: "mutation_rejected",
            });
            expect(mutations).toBe(2);
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("keeps a pending mutation across a stream reconnect", async () => {
        const streams: ReturnType<typeof streamResponse>[] = [];
        const response = deferred<Response>();
        let mutationCalls = 0;
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: (input) => {
                const url = new URL(String(input));
                if (url.pathname.endsWith("/stream")) {
                    const stream = streamResponse();
                    streams.push(stream);
                    return Promise.resolve(stream.response);
                }
                mutationCalls += 1;
                return response.promise;
            },
            randomValues,
            token: "secret",
            wait: () => Promise.resolve(),
        });
        const connection = rig.connectSession({
            onChange: () => undefined,
            sessionId: "session-1",
        });
        try {
            await settle();
            streams[0]?.write(hello());
            await settle();
            rig.switchModel("session-1", "new-model");
            streams[0]?.close();
            await settle();

            expect(streams).toHaveLength(2);
            expect(connection.session().modelId).toBe("new-model");
            expect(mutationCalls).toBe(1);
            response.resolve(
                new Response(JSON.stringify({ session: { lastEventId: "accepted" } }), {
                    status: 200,
                }),
            );
            await settle();
            expect(connection.session().modelId).toBe("new-model");
            streams[1]?.write(hello("authoritative-model"));
            await settle();
            // A completed mutation is committed, not retained as an overlay
            // that can overwrite a later recovery snapshot forever.
            expect(connection.session().modelId).toBe("authoritative-model");
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("aborts retry work and stops publishing when closed", async () => {
        const stream = streamResponse();
        const retry = deferred<void>();
        let mutationCalls = 0;
        let renders = 0;
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: (input) => {
                const url = new URL(String(input));
                if (url.pathname.endsWith("/stream")) return Promise.resolve(stream.response);
                mutationCalls += 1;
                return Promise.reject(new TypeError("offline"));
            },
            randomValues,
            token: "secret",
            wait: () => retry.promise,
        });
        const connection = rig.connectSession({
            onChange: () => {
                renders += 1;
            },
            sessionId: "session-1",
        });
        stream.write(hello());
        await settle();
        rig.sendMessage("session-1", "Pending");
        await settle();
        const beforeClose = renders;

        rig.close();
        retry.resolve();
        await settle();

        expect(mutationCalls).toBe(1);
        expect(renders).toBe(beforeClose);
        expect(() => rig.sendMessage("session-1", "Too late")).toThrow(/closed/u);
        connection.close();
    });

    it("acknowledges an optimistic message from its stream echo", async () => {
        const stream = streamResponse();
        const response = deferred<Response>();
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: (input) => {
                const url = new URL(String(input));
                return url.pathname.endsWith("/stream")
                    ? Promise.resolve(stream.response)
                    : response.promise;
            },
            randomValues,
            token: "secret",
        });
        const connection = rig.connectSession({
            onChange: () => undefined,
            sessionId: "session-1",
        });
        try {
            stream.write(hello());
            await settle();
            const mutationId = rig.sendMessage("session-1", "Echoed");
            stream.write(
                event("message_submitted", {
                    delivery: "run",
                    displayText: "Echoed",
                    message: {
                        blocks: [{ text: "Echoed", type: "text" }],
                        id: mutationId,
                        role: "user",
                    },
                    mutationId,
                    runId: "run-1",
                }),
            );
            await settle();

            expect(
                connection
                    .elements()
                    .filter(
                        (element) =>
                            element.kind === "user_message" && element.messageId === mutationId,
                    ),
            ).toHaveLength(1);
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("renames a group immediately and sends its authoritative version", async () => {
        const stream = streamResponse();
        let mutationRequest: { init?: RequestInit; url: URL } | undefined;
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: (input, init) => {
                const url = new URL(String(input));
                if (url.pathname === "/events/stream") return Promise.resolve(stream.response);
                mutationRequest = { ...(init === undefined ? {} : { init }), url };
                return Promise.resolve(
                    new Response(
                        JSON.stringify({
                            project: { id: "project-1", name: "After (2)", version: 4 },
                        }),
                        { status: 200 },
                    ),
                );
            },
            randomValues,
            token: "secret",
        });
        const connection = rig.connectGroups({ onChange: () => undefined });
        try {
            stream.write(groupsHello());
            await settle();
            const mutationId = rig.renameGroup(
                { kind: "project", projectId: "project-1" },
                "After",
            );

            expect(connection.projects()[0]?.name).toBe("After");
            expect(mutationRequest?.url.pathname).toBe("/projects/project-1");
            expect((mutationRequest?.init?.headers as Record<string, string>)["if-match"]).toBe(
                '"3"',
            );
            expect(JSON.parse(String(mutationRequest?.init?.body))).toEqual({
                mutationId,
                name: "After",
            });
            await settle();
            expect(connection.projects()[0]?.name).toBe("After (2)");
        } finally {
            connection.close();
            rig.close();
        }
    });
});
