import { describe, expect, it } from "vitest";

import { ChatStore } from "@/ChatStore.js";
import type { ChatDelta, ChatElement, ToolCallElement } from "@/ChatElement.js";
import type {
    AgentLoopEvent,
    Message,
    ScheduledMessage,
    SessionEvent,
    SessionStreamHello,
} from "@/protocol.js";
import { SERVICE_NOTICE_TEXT_MAX_LENGTH } from "@/protocol.js";

let clock = 0;

function event<TType extends string>(type: TType, data: unknown): SessionEvent {
    clock += 1;
    return {
        createdAt: clock,
        data,
        id: `event-${clock}`,
        sessionId: "session-1",
        type,
    } as SessionEvent;
}

function agentEvent(inner: AgentLoopEvent): SessionEvent {
    return event("agent_event", { event: inner, runId: "run-1" });
}

function hello(overrides: Partial<SessionStreamHello> = {}): SessionStreamHello {
    return {
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
        ...overrides,
    };
}

/** Runs a turn with one assistant message and one tool call. */
function runOneTurn(store: ChatStore): ChatDelta[] {
    const deltas: ChatDelta[] = [];
    const push = (applied: readonly ChatDelta[]) => deltas.push(...applied);
    push(store.apply(event("run_started", { runId: "run-1" })));
    push(
        store.apply(
            agentEvent({ iteration: 1, messageId: "m1", type: "inference_iteration_start" }),
        ),
    );
    push(store.apply(agentEvent({ contentIndex: 0, messageId: "m1", type: "text_start" })));
    push(
        store.apply(
            agentEvent({ contentIndex: 0, delta: "Let me ", messageId: "m1", type: "text_delta" }),
        ),
    );
    push(
        store.apply(
            agentEvent({ contentIndex: 0, delta: "check.", messageId: "m1", type: "text_delta" }),
        ),
    );
    push(
        store.apply(
            agentEvent({
                content: "Let me check.",
                contentIndex: 0,
                messageId: "m1",
                type: "text_end",
            }),
        ),
    );
    push(
        store.apply(
            agentEvent({
                toolCall: {
                    arguments: { command: "ls" },
                    id: "call-1",
                    name: "Bash",
                    type: "tool_call",
                },
                type: "tool_execution_start",
            }),
        ),
    );
    push(
        store.apply(
            agentEvent({
                result: {
                    display: "3 files",
                    isError: false,
                    toolCallId: "call-1",
                    toolName: "Bash",
                },
                type: "tool_execution_end",
            }),
        ),
    );
    push(store.apply(event("run_finished", { runId: "run-1", stopReason: "stop" })));
    return deltas;
}

describe("ChatStore", () => {
    it("rebuilds a tail context anchor without restoring a live turn", () => {
        const message = {
            blocks: [{ text: "Use the blue database.", type: "text" as const }],
            contextOnly: true as const,
            id: "context-1",
            role: "user" as const,
        };
        const opening = {
            ...hello(),
            transcript: {
                complete: true,
                messageCreatedAt: { "context-1": 10 },
                messages: [message],
                turns: [
                    {
                        messageIds: ["context-1"],
                        runId: "context:context-1",
                        startedAt: 10,
                    },
                ],
            },
        };
        const store = new ChatStore("session-1");
        store.applyHello(opening);
        const contextElement = store.elements()[0];
        const futureGroupId = "group:context:context-1";

        expect(store.session().activeTurn).toBeUndefined();
        expect(contextElement).toMatchObject({
            contextOnly: true,
            groupId: futureGroupId,
            kind: "user_message",
            runId: "context:context-1",
        });

        store.applyHello(opening);
        expect(store.elements()[0]).toBe(contextElement);
        store.apply(
            event("message_submitted", {
                delivery: "run",
                displayText: "Check the migration.",
                message: {
                    blocks: [{ text: "Check the migration.", type: "text" }],
                    id: "request-1",
                    role: "user",
                },
                runId: "run-1",
            }),
        );
        store.apply(event("run_started", { runId: "run-1" }));
        store.apply(
            agentEvent({
                iteration: 1,
                messageId: "answer-1",
                type: "inference_iteration_start",
            }),
        );
        expect(store.elements()[0]).toBe(contextElement);
        expect(store.elements()[0]?.groupId).toBe(futureGroupId);
        expect(store.session().activeGroup?.groupId).toBe(futureGroupId);
    });

    it("keeps a context note submitted during work anchored to the next group", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(
            event("message_submitted", {
                delivery: "run",
                displayText: "Start the first request.",
                message: {
                    blocks: [{ text: "Start the first request.", type: "text" }],
                    id: "request-1",
                    role: "user",
                },
                runId: "run-1",
            }),
        );
        store.apply(event("run_started", { runId: "run-1" }));
        store.apply(
            agentEvent({
                iteration: 1,
                messageId: "answer-1",
                type: "inference_iteration_start",
            }),
        );
        const activeTurn = store.session().activeTurn;
        const currentGroupId = store.session().activeGroup?.groupId;

        store.apply(
            event("message_submitted", {
                delivery: "context",
                displayText: "Use the blue database.",
                message: {
                    blocks: [{ text: "Use the blue database.", type: "text" }],
                    contextOnly: true,
                    id: "context-1",
                    role: "user",
                },
                runId: "context:context-1",
            }),
        );
        const contextElement = store
            .elements()
            .find((element) => element.kind === "user_message" && element.contextOnly === true);
        expect(contextElement?.groupId).toBe("group:context:context-1");
        expect(contextElement?.groupId).not.toBe(currentGroupId);
        expect(store.session().activeTurn).toBe(activeTurn);
        expect(store.session().activeTurn?.startedAt).toBe(activeTurn?.startedAt);

        store.apply(event("run_finished", { runId: "run-1", stopReason: "stop" }));
        store.apply(
            event("message_submitted", {
                delivery: "run",
                displayText: "Run the follow-up.",
                message: {
                    blocks: [{ text: "Run the follow-up.", type: "text" }],
                    id: "request-2",
                    role: "user",
                },
                runId: "run-2",
            }),
        );
        const followUpElement = store
            .elements()
            .find(
                (element) => element.kind === "user_message" && element.messageId === "request-2",
            );
        store.apply(event("run_started", { runId: "run-2" }));
        store.apply(
            event("agent_event", {
                event: {
                    iteration: 1,
                    messageId: "answer-2",
                    type: "inference_iteration_start",
                },
                runId: "run-2",
            }),
        );

        expect(
            store
                .elements()
                .find((element) => element.kind === "user_message" && element.contextOnly === true),
        ).toBe(contextElement);
        expect(
            store
                .elements()
                .find(
                    (element) =>
                        element.kind === "user_message" && element.messageId === "request-2",
                ),
        ).toBe(followUpElement);
        expect(store.session().activeGroup?.groupId).toBe("group:context:context-1");
    });

    it("does not requeue a replayed context note after its group has started", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        const submitted = event("message_submitted", {
            delivery: "context",
            displayText: "Use the blue database.",
            message: {
                blocks: [{ text: "Use the blue database.", type: "text" }],
                contextOnly: true,
                id: "context-1",
                role: "user",
            },
            runId: "context:context-1",
        });
        store.apply(submitted);
        const contextElement = store.elements()[0];
        store.apply(
            event("message_submitted", {
                delivery: "run",
                displayText: "First action.",
                message: {
                    blocks: [{ text: "First action.", type: "text" }],
                    id: "request-1",
                    role: "user",
                },
                runId: "run-1",
            }),
        );
        store.apply(event("run_started", { runId: "run-1" }));
        store.apply(
            agentEvent({
                iteration: 1,
                messageId: "answer-1",
                type: "inference_iteration_start",
            }),
        );
        store.apply(submitted);
        store.apply(event("run_finished", { runId: "run-1", stopReason: "stop" }));
        store.apply(
            event("message_submitted", {
                delivery: "run",
                displayText: "Second action.",
                message: {
                    blocks: [{ text: "Second action.", type: "text" }],
                    id: "request-2",
                    role: "user",
                },
                runId: "run-2",
            }),
        );
        store.apply(event("run_started", { runId: "run-2" }));
        store.apply(
            event("agent_event", {
                event: {
                    iteration: 1,
                    messageId: "answer-2",
                    type: "inference_iteration_start",
                },
                runId: "run-2",
            }),
        );

        expect(store.elements().filter((element) => element.id === "message:context-1")).toEqual([
            contextElement,
        ]);
        expect(store.elements().find((element) => element.id === "message:context-1")).toBe(
            contextElement,
        );
        expect(contextElement?.groupId).toBe("group:context:context-1");
        expect(store.session().activeGroup?.groupId).not.toBe(contextElement?.groupId);
    });

    it("binds an older-page context note to the first existing actionable group", () => {
        const request = {
            blocks: [{ text: "Check the migration.", type: "text" as const }],
            id: "request-1",
            role: "user" as const,
        };
        const answer = {
            blocks: [{ text: "Done.", type: "text" as const }],
            id: "answer-1",
            role: "agent" as const,
        };
        const store = new ChatStore("session-1");
        store.applyHello({
            ...hello(),
            transcript: {
                complete: false,
                messageCreatedAt: { "answer-1": 30, "request-1": 20 },
                messages: [request, answer],
                turns: [
                    {
                        endedAt: 40,
                        groups: [{ endedAt: 40, id: "answer-1", startedAt: 30 }],
                        messageIds: ["request-1", "answer-1"],
                        outcome: "success",
                        runId: "run-1",
                        startedAt: 20,
                    },
                ],
            },
        });
        const existingElements = [...store.elements()];
        const boundaryGroupId = existingElements[0]?.groupId;

        store.prependEarlier({
            complete: true,
            messageCreatedAt: { "context-1": 10 },
            messages: [
                {
                    blocks: [{ text: "Use the blue database.", type: "text" }],
                    contextOnly: true,
                    id: "context-1",
                    role: "user",
                },
            ],
            turns: [
                {
                    messageIds: ["context-1"],
                    runId: "context:context-1",
                    startedAt: 10,
                },
            ],
        });

        expect(
            store.elements().find((element) => element.id === "message:context-1"),
        ).toMatchObject({
            contextOnly: true,
            groupId: boundaryGroupId,
        });
        expect(store.elements().slice(1)).toEqual(existingElements);
        for (const [index, element] of existingElements.entries()) {
            expect(store.elements()[index + 1]).toBe(element);
        }
    });

    it("attaches context forward without activating or patching the session", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        const sessionBefore = store.session();
        store.apply(
            event("message_submitted", {
                delivery: "context",
                displayText: "Use the blue database.",
                message: {
                    blocks: [{ text: "Use the blue database.", type: "text" }],
                    contextOnly: true,
                    id: "context-1",
                    role: "user",
                },
                runId: "context:context-1",
            }),
        );

        expect(store.session().activity).toBe(sessionBefore.activity);
        expect(store.session().status).toBe(sessionBefore.status);
        expect(store.elements()).toMatchObject([
            {
                contextOnly: true,
                kind: "user_message",
                messageId: "context-1",
                runId: "context:context-1",
            },
        ]);

        store.apply(
            event("message_submitted", {
                delivery: "run",
                displayText: "Check the migration.",
                message: {
                    blocks: [{ text: "Check the migration.", type: "text" }],
                    id: "request-1",
                    role: "user",
                },
                runId: "run-1",
            }),
        );
        store.apply(event("run_started", { runId: "run-1" }));
        store.apply(
            agentEvent({
                iteration: 1,
                messageId: "answer-1",
                type: "inference_iteration_start",
            }),
        );

        const messages = store.elements().filter((element) => element.kind === "user_message");
        expect(messages[0]?.groupId).toBe(messages[1]?.groupId);
        expect(store.session().activeTurn?.runId).toBe("run-1");
    });

    it("commits final-message attachments before closing the live turn", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(event("run_started", { runId: "run-1" }));
        store.apply(
            agentEvent({ iteration: 1, messageId: "m1", type: "inference_iteration_start" }),
        );
        store.apply(
            event("agent_message", {
                message: {
                    blocks: [{ text: "Done.", type: "text" }],
                    id: "m1",
                    role: "agent",
                },
                runId: "run-1",
            }),
        );
        store.apply(
            event("run_finished", {
                attachmentMessageId: "m1",
                attachments: [
                    {
                        bytes: 10,
                        height: 20,
                        id: "image-1",
                        kind: "image",
                        mediaType: "image/png",
                        name: "result.png",
                        source: "generated/result.png",
                        thumbhash: "AQID",
                        width: 30,
                    },
                ],
                modelLocked: false,
                runId: "run-1",
                stopReason: "stop",
            }),
        );

        expect(store.elements().map((element) => element.kind)).toEqual([
            "agent_text",
            "agent_attachments",
            "group_end",
        ]);
        expect(store.elements()[1]).toMatchObject({
            kind: "agent_attachments",
            messageId: "m1",
        });
    });

    it("projects complete application state and keeps it current from events", () => {
        const store = new ChatStore("session-1");
        const opening = hello();
        opening.session = {
            ...opening.session!,
            agent: { depth: 0, rootSessionId: "session-1", type: "primary" },
            agentId: "agent-1",
            environment: { type: "local" },
            mcpServers: [{ name: "docs", status: "connected", toolCount: 3 }],
            projectSecretIds: ["project-secret"],
            secretIds: ["project-secret"],
            sessionSecretIds: [],
            titleStatus: "generating",
            workflows: [
                {
                    agentCount: 1,
                    code: "print('hi')",
                    description: "Run it",
                    logs: [],
                    name: "demo",
                    runId: "workflow-1",
                    startedAt: 10,
                    status: "running",
                    taskId: "task-1",
                },
            ],
            workflowsEnabled: true,
        };
        store.applyHello(opening);
        store.apply(
            event("session_updated", {
                mutationId: "mutation-1",
                session: { ...opening.session!, appendSystemPrompt: "Always verify." },
            }),
        );

        expect(store.session()).toMatchObject({
            agentId: "agent-1",
            appendSystemPrompt: "Always verify.",
            environment: { type: "local" },
            mcpServers: [{ name: "docs", status: "connected", toolCount: 3 }],
            secretIds: ["project-secret"],
            titleStatus: "generating",
            workflowsEnabled: true,
        });

        store.apply(
            event("secrets_changed", {
                projectSecretIds: ["project-secret"],
                secretIds: ["project-secret", "session-secret"],
                sessionSecretIds: ["session-secret"],
            }),
        );
        store.apply(
            event("workflow_changed", {
                update: { log: "halfway", runId: "workflow-1", phase: "Verify" },
            }),
        );
        store.apply(
            event("mcp_servers_changed", {
                servers: [{ name: "docs", status: "failed", toolCount: 0 }],
            }),
        );
        store.apply(
            event("session_title_changed", {
                errorMessage: "Could not generate a title.",
                status: "error",
            }),
        );

        expect(store.session()).toMatchObject({
            mcpServers: [{ name: "docs", status: "failed", toolCount: 0 }],
            secretIds: ["project-secret", "session-secret"],
            sessionSecretIds: ["session-secret"],
            titleError: "Could not generate a title.",
            titleStatus: "error",
            workflows: [expect.objectContaining({ logs: ["halfway"], phase: "Verify" })],
        });
    });

    it("reconciles restart-only current state on a resumed stream", () => {
        const store = new ChatStore("session-1");
        const opening = hello();
        opening.session = {
            ...opening.session!,
            interruption: {
                interruptedAt: 10,
                message: "The daemon stopped.",
                reason: "shutdown",
            },
            mcpServers: [{ name: "old", status: "connected", toolCount: 1 }],
            projectSecretIds: [],
            secretIds: [],
            sessionSecretIds: [],
            titleError: "old error",
            titleStatus: "error",
            workflows: [],
        };
        store.applyHello(opening);

        store.applyHello({
            activity: { kind: "idle", label: "Idle", since: 20 },
            current: {
                mcpServers: [],
                projectSecretIds: [],
                secretIds: [],
                sessionSecretIds: [],
                titleStatus: "ready",
                workflows: [],
                workflowsEnabled: true,
            },
            resumed: true,
        });

        expect(store.session()).toMatchObject({
            mcpServers: [],
            titleStatus: "ready",
            workflowsEnabled: true,
        });
        expect(store.session().interruption).toBeUndefined();
        expect(store.session().titleError).toBeUndefined();
    });

    it("restores scheduled messages and applies durable status updates", () => {
        const scheduled: ScheduledMessage = {
            createdAt: 10,
            dueAt: 20,
            id: "scheduled-1",
            message: "Check the deployment.",
            senderSessionId: "session-1",
            status: "pending",
            targetAgentId: "agent-2",
            updatedAt: 10,
        };
        const store = new ChatStore("session-1");
        store.applyHello(
            hello({
                session: {
                    ...hello().session!,
                    scheduledMessages: [scheduled],
                },
            }),
        );

        expect(store.session().scheduledMessages).toEqual([scheduled]);

        const cancelled: ScheduledMessage = {
            ...scheduled,
            status: "cancelled",
            updatedAt: 15,
        };
        const deltas = store.apply(
            event("scheduled_message_changed", {
                message: cancelled,
                mutationId: "cancel-1",
            }),
        );

        expect(store.session().scheduledMessages).toEqual([cancelled]);
        expect(deltas).toContainEqual({
            session: expect.objectContaining({ scheduledMessages: [cancelled] }),
            type: "session_changed",
        });

        const delivered: ScheduledMessage = {
            ...scheduled,
            deliveredAt: 20,
            status: "delivered",
            updatedAt: 20,
        };
        store.applyHello({
            activity: { kind: "idle", label: "Idle", since: 20 },
            current: { scheduledMessages: [delivered] },
            resumed: true,
        });
        expect(store.session().scheduledMessages).toEqual([delivered]);
    });

    it("removes pruned scheduled-message history while connected", () => {
        const retained: ScheduledMessage = {
            createdAt: 10,
            dueAt: 20,
            id: "scheduled-retained",
            message: "Retain this.",
            senderSessionId: "session-1",
            status: "cancelled",
            targetAgentId: "agent-2",
            updatedAt: 15,
        };
        const pruned = {
            ...retained,
            id: "scheduled-pruned",
            message: "Prune this.",
        };
        const store = new ChatStore("session-1");
        store.applyHello(
            hello({
                session: {
                    ...hello().session!,
                    scheduledMessages: [pruned, retained],
                },
            }),
        );

        store.apply(
            event("scheduled_messages_pruned", {
                messageIds: [pruned.id],
            }),
        );

        expect(store.session().scheduledMessages).toEqual([retained]);
    });

    it("builds a flat, time-ordered list with one element per message, block, and tool call", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        runOneTurn(store);

        expect(store.elements().map((element) => element.kind)).toEqual([
            "agent_text",
            "tool_call",
            "group_end",
        ]);
    });

    it("gives every element the turn it belongs to", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        runOneTurn(store);

        expect(store.elements().every((element) => element.runId === "run-1")).toBe(true);
    });

    it("always ends a turn with a final element that states the outcome", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        runOneTurn(store);

        const last = store.elements().at(-1);
        expect(last).toMatchObject({ kind: "group_end", outcome: "success" });
    });

    it("keeps a whole tool-calling answer in one group under one footer", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(
            event("message_submitted", {
                delivery: "run",
                displayText: "Ask",
                message: { blocks: [{ text: "Ask", type: "text" }], id: "u1", role: "user" },
                runId: "run-1",
            }),
        );
        store.apply(event("run_started", { runId: "run-1" }));
        // Working through tools reaches the model three times. The person asked
        // one question, so they see one answer that ends once.
        for (const [index, messageId] of ["m1", "m2", "m3"].entries()) {
            store.apply(
                agentEvent({ iteration: index + 1, messageId, type: "inference_iteration_start" }),
            );
            store.apply(agentEvent({ contentIndex: 0, messageId, type: "text_start" }));
            store.apply(
                agentEvent({
                    content: `Step ${String(index)}`,
                    contentIndex: 0,
                    messageId,
                    type: "text_end",
                }),
            );
            if (index === 2) continue;
            store.apply(
                agentEvent({
                    toolCall: {
                        arguments: { command: "ls" },
                        id: `call-${String(index)}`,
                        name: "Bash",
                        type: "tool_call",
                    },
                    type: "tool_execution_start",
                }),
            );
            store.apply(
                agentEvent({
                    result: {
                        display: "ok",
                        isError: false,
                        toolCallId: `call-${String(index)}`,
                        toolName: "Bash",
                    },
                    type: "tool_execution_end",
                }),
            );
        }
        store.apply(event("run_finished", { runId: "run-1", stopReason: "stop" }));

        const elements = store.elements();
        expect(new Set(elements.map((element) => element.groupId)).size).toBe(1);
        expect(elements.map((element) => element.kind)).toEqual([
            "user_message",
            "agent_text",
            "tool_call",
            "agent_text",
            "tool_call",
            "agent_text",
            "group_end",
        ]);
        expect(elements.at(-1)).toMatchObject({ outcome: "success", reason: "completed" });
    });

    it("creates an empty group row before output and reuses its identity for the first token", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(event("run_started", { runId: "run-1" }));
        store.apply(
            agentEvent({ iteration: 1, messageId: "message-1", type: "inference_iteration_start" }),
        );

        const waiting = store.elements().at(-1);
        expect(waiting).toMatchObject({
            groupId: "group:message-1",
            kind: "inference",
            state: "waiting",
        });
        expect(store.session().activeGroup).toEqual({
            groupId: "group:message-1",
            runId: "run-1",
            startedAt: expect.any(Number),
        });

        store.apply(
            agentEvent({
                contentIndex: 0,
                delta: "H",
                messageId: "message-1",
                type: "text_delta",
            }),
        );
        expect(store.elements().find((element) => element.id === waiting?.id)).toMatchObject({
            groupId: "group:message-1",
            id: waiting?.id,
            kind: "agent_text",
            text: "H",
        });
    });

    it("orders steering as group end, all steering messages, then the next group", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(event("run_started", { runId: "run-1" }));
        store.apply(
            agentEvent({ iteration: 1, messageId: "message-1", type: "inference_iteration_start" }),
        );
        for (const id of ["steer-1", "steer-2"]) {
            store.apply(
                event("message_submitted", {
                    delivery: "steer",
                    displayText: id,
                    message: { blocks: [{ text: id, type: "text" }], id, role: "user" },
                    runId: "run-1",
                }),
            );
        }
        store.apply(
            event("steering_applied", {
                messageIds: ["steer-1", "steer-2"],
                runId: "run-1",
            }),
        );
        store.apply(
            agentEvent({ iteration: 2, messageId: "message-2", type: "inference_iteration_start" }),
        );

        const relevant = store
            .elements()
            .filter(
                (element) =>
                    element.kind === "group_end" ||
                    (element.kind === "user_message" &&
                        ["steer-1", "steer-2"].includes(element.messageId)) ||
                    element.id === "group-start:message-2",
            );
        expect(relevant.map((element) => element.kind)).toEqual([
            "group_end",
            "user_message",
            "user_message",
            "inference",
        ]);
        expect(relevant.slice(1).every((element) => element.groupId === "group:message-2")).toBe(
            true,
        );
    });

    it("closes an aborted group once before the run finishes", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(event("run_started", { runId: "run-1" }));
        store.apply(
            agentEvent({ iteration: 1, messageId: "message-1", type: "inference_iteration_start" }),
        );
        store.apply(event("abort_requested", { runId: "run-1" }));
        store.apply(event("run_finished", { runId: "run-1", stopReason: "aborted" }));

        expect(store.elements().filter((element) => element.kind === "group_end")).toEqual([
            expect.objectContaining({ outcome: "stopped", reason: "abort" }),
        ]);
        expect(store.session().activeGroup).toBeUndefined();
    });

    it("keeps a group open across the technical abort used to continue steering", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(event("run_started", { runId: "run-1" }));
        store.apply(
            agentEvent({ iteration: 1, messageId: "message-1", type: "inference_iteration_start" }),
        );
        store.apply(
            event("abort_requested", {
                continuePendingSteering: true,
                runId: "run-1",
            }),
        );

        expect(store.elements().some((element) => element.kind === "group_end")).toBe(false);
        expect(store.session().activeGroup).toMatchObject({
            groupId: "group:message-1",
            runId: "run-1",
        });
    });

    it("keeps authoritative active turn timing through steering and activity changes", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        const submitted = event("message_submitted", {
            delivery: "run",
            displayText: "Start",
            message: {
                blocks: [{ text: "Start", type: "text" }],
                id: "user-1",
                role: "user",
            },
            runId: "run-1",
        });
        store.apply(submitted);

        expect(store.session()).toMatchObject({
            activeTurn: { runId: "run-1", startedAt: submitted.createdAt },
        });

        store.apply(
            event("message_submitted", {
                delivery: "steer",
                displayText: "Continue",
                message: {
                    blocks: [{ text: "Continue", type: "text" }],
                    id: "steer-1",
                    role: "user",
                },
                runId: "run-1",
            }),
        );
        store.apply(
            event("session_activity_changed", {
                activity: { kind: "thinking", label: "Thinking", since: 99 },
            }),
        );
        store.applyHello({
            activity: { kind: "executing_tool_call", label: "Running a tool", since: 120 },
            resumed: true,
        });

        expect(store.session()).toMatchObject({
            activeTurn: { runId: "run-1", startedAt: submitted.createdAt },
        });
    });

    it("pins pending steering as one message bubble and restores chronological order on acceptance", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(event("run_started", { runId: "run-1" }));
        store.apply(
            event("message_submitted", {
                delivery: "steer",
                displayText: "Check this too",
                message: {
                    blocks: [{ text: "Check this too", type: "text" }],
                    id: "steer-1",
                    role: "user",
                },
                runId: "run-1",
            }),
        );
        const stableId = store.elements().at(-1)?.id;
        store.apply(
            agentEvent({
                contentIndex: 0,
                delta: "Still working",
                messageId: "agent-live",
                type: "text_delta",
            }),
        );

        expect(store.elements().at(-1)).toMatchObject({
            delivery: "pending_steering",
            id: stableId,
            kind: "user_message",
            messageId: "steer-1",
        });
        expect(
            store
                .elements()
                .filter(
                    (element) => element.kind === "user_message" && element.messageId === "steer-1",
                ),
        ).toHaveLength(1);

        store.apply(event("steering_applied", { messageIds: ["steer-1"], runId: "run-1" }));

        const acceptedIndex = store.elements().findIndex((element) => element.id === stableId);
        const laterAgentIndex = store
            .elements()
            .findIndex((element) => element.id === "agent-live:agent_text:0");
        expect(store.elements()[acceptedIndex]).toMatchObject({
            delivery: "sent",
            id: stableId,
            messageId: "steer-1",
        });
        expect(acceptedIndex).toBeGreaterThan(laterAgentIndex);
    });

    it("keeps multiple steering bubbles in queue order through back-to-back acceptance", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        const started = event("run_started", { runId: "run-1" });
        store.apply(started);
        for (const id of ["steer-1", "steer-2"]) {
            store.apply(
                event("message_submitted", {
                    delivery: "steer",
                    displayText: id,
                    message: {
                        blocks: [{ text: id, type: "text" }],
                        id,
                        role: "user",
                    },
                    runId: "run-1",
                }),
            );
        }
        store.apply(
            agentEvent({
                contentIndex: 0,
                delta: "New work",
                messageId: "agent-after-steering",
                type: "text_delta",
            }),
        );

        expect(
            store
                .elements()
                .slice(-2)
                .map((element) =>
                    element.kind === "user_message" ? element.messageId : element.kind,
                ),
        ).toEqual(["steer-1", "steer-2"]);

        const firstApplied = event("steering_applied", {
            messageIds: ["steer-1"],
            runId: "run-1",
        });
        store.apply(firstApplied);
        expect(store.elements().at(-1)).toMatchObject({
            delivery: "pending_steering",
            messageId: "steer-2",
        });
        const secondApplied = event("steering_applied", {
            messageIds: ["steer-2"],
            runId: "run-1",
        });
        store.apply(secondApplied);

        const order = store
            .elements()
            .filter((element) => element.kind === "user_message")
            .map((element) => [element.messageId, element.delivery]);
        expect(order).toEqual([
            ["steer-1", "sent"],
            ["steer-2", "sent"],
        ]);
        expect(
            store
                .elements()
                .filter((element) => element.kind === "user_message")
                .map((element) => ({
                    elapsedMs: element.steeringElapsedMs,
                    steeredAt: element.steeredAt,
                })),
        ).toEqual([
            {
                elapsedMs: firstApplied.createdAt - started.createdAt,
                steeredAt: firstApplied.createdAt,
            },
            {
                elapsedMs: secondApplied.createdAt - firstApplied.createdAt,
                steeredAt: secondApplied.createdAt,
            },
        ]);
        expect(store.elements().at(-1)?.kind).toBe("user_message");
    });

    it("gives a batch one steering time and measures it only once", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        const started = event("run_started", { runId: "run-1" });
        store.apply(started);
        for (const id of ["steer-1", "steer-2"]) {
            store.apply(
                event("message_submitted", {
                    delivery: "steer",
                    displayText: id,
                    message: {
                        blocks: [{ text: id, type: "text" }],
                        id,
                        role: "user",
                    },
                    runId: "run-1",
                }),
            );
        }
        const applied = event("steering_applied", {
            messageIds: ["steer-1", "steer-2"],
            runId: "run-1",
        });

        store.apply(applied);

        expect(
            store
                .elements()
                .filter((element) => element.kind === "user_message")
                .map((element) => ({
                    elapsedMs: element.steeringElapsedMs,
                    steeredAt: element.steeredAt,
                })),
        ).toEqual([
            {
                elapsedMs: applied.createdAt - started.createdAt,
                steeredAt: applied.createdAt,
            },
            { elapsedMs: 0, steeredAt: applied.createdAt },
        ]);
    });

    it("rebuilds pending steering once at the transcript tail on attach", () => {
        const opening = hello();
        const committed = {
            blocks: [{ text: "Working", type: "text" as const }],
            id: "agent-before-pending",
            role: "agent" as const,
        };
        const store = new ChatStore("session-1");
        const recovered: SessionStreamHello = {
            ...opening,
            session: {
                ...opening.session!,
                snapshot: { messages: [committed] },
                pendingSteeringMessages: [
                    {
                        createdAt: 3_000,
                        message: {
                            blocks: [{ text: "Queued", type: "text" as const }],
                            id: "steer-recovered",
                            role: "user" as const,
                        },
                        runId: "run-2",
                    },
                ],
            },
            transcript: {
                complete: true,
                messageCreatedAt: { "agent-before-pending": 2_000 },
                messages: [committed],
                turns: [
                    {
                        messageIds: ["agent-before-pending"],
                        runId: "run-2",
                        startedAt: 1_000,
                    },
                ],
            },
        };
        store.applyHello(recovered);

        expect(store.elements().at(-1)).toMatchObject({
            createdAt: 3_000,
            delivery: "pending_steering",
            messageId: "steer-recovered",
        });
        expect(
            store
                .elements()
                .filter(
                    (element) =>
                        element.kind === "user_message" && element.messageId === "steer-recovered",
                ),
        ).toHaveLength(1);
        const pendingBeforeReconnect = store.elements().at(-1);
        store.applyHello(recovered);
        expect(store.elements().at(-1)).toBe(pendingBeforeReconnect);
    });

    it("attaches restored permission reviews to their historical tool calls", () => {
        const opening = hello();
        const message = {
            blocks: [
                {
                    arguments: { command: "pnpm test" },
                    id: "reviewed-call",
                    name: "exec_command",
                    type: "tool_call" as const,
                },
            ],
            id: "agent-reviewed",
            role: "agent" as const,
        };
        const store = new ChatStore("session-1");
        const recovered: SessionStreamHello = {
            ...opening,
            session: {
                ...opening.session!,
                permissionReviews: [
                    {
                        action: "Run tests",
                        decision: "allow",
                        reason: "Requested",
                        risk: "low",
                        toolCallId: "reviewed-call",
                        userAuthorization: "high",
                    },
                ],
                snapshot: { messages: [message] },
            },
            transcript: {
                complete: true,
                messages: [message],
                turns: [
                    {
                        messageIds: [message.id],
                        runId: "run-reviewed",
                        startedAt: 1,
                    },
                ],
            },
        };
        store.applyHello(recovered);

        expect(
            store
                .elements()
                .find(
                    (element) =>
                        element.kind === "tool_call" && element.toolCallId === "reviewed-call",
                ),
        ).toMatchObject({
            permissionReview: {
                decision: "allow",
                status: "completed",
                toolCallId: "reviewed-call",
                userAuthorization: "high",
            },
        });
        const reviewedBeforeRecovery = store
            .elements()
            .find(
                (element) => element.kind === "tool_call" && element.toolCallId === "reviewed-call",
            );
        store.applyHello(recovered);
        expect(
            store
                .elements()
                .find(
                    (element) =>
                        element.kind === "tool_call" && element.toolCallId === "reviewed-call",
                ),
        ).toBe(reviewedBeforeRecovery);
        const pagedMessage: Message = {
            blocks: [
                {
                    arguments: { path: "README.md" },
                    id: "paged-reviewed-call",
                    name: "read",
                    type: "tool_call",
                },
            ],
            id: "agent-paged-reviewed",
            role: "agent",
        };
        store.prependEarlier({
            complete: true,
            messages: [pagedMessage],
            permissionReviews: [
                {
                    action: "Read history",
                    decision: "allow",
                    reason: "Requested",
                    risk: "low",
                    toolCallId: "paged-reviewed-call",
                    userAuthorization: "high",
                },
            ],
            turns: [
                {
                    messageIds: [pagedMessage.id],
                    runId: "run-paged-reviewed",
                    startedAt: 0,
                },
            ],
        });
        expect(
            store
                .elements()
                .find(
                    (element) =>
                        element.kind === "tool_call" &&
                        element.toolCallId === "paged-reviewed-call",
                ),
        ).toMatchObject({
            permissionReview: {
                decision: "allow",
                status: "completed",
                toolCallId: "paged-reviewed-call",
            },
        });
    });

    it("updates one tool row from automatic review progress to its complete verdict", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        const toolMessage: Message = {
            blocks: [
                {
                    arguments: { command: "deploy" },
                    id: "review-progress-call",
                    name: "exec_command",
                    type: "tool_call",
                },
            ],
            id: "review-progress-message",
            role: "agent",
        };
        store.apply(
            event("agent_message", {
                message: toolMessage,
                runId: "run-review-progress",
            }),
        );

        store.apply(
            agentEvent({
                action: "Deploy the service",
                toolCallId: "review-progress-call",
                toolName: "exec_command",
                type: "permission_review_started",
            }),
        );
        expect(
            store
                .elements()
                .find(
                    (element) =>
                        element.kind === "tool_call" &&
                        element.toolCallId === "review-progress-call",
                ),
        ).toMatchObject({
            permissionReview: {
                action: "Deploy the service",
                status: "reviewing",
                toolCallId: "review-progress-call",
            },
        });

        store.apply(
            agentEvent({
                action: "Deploy the service",
                decision: "deny",
                reason: "The user did not authorize deployment.",
                risk: "high",
                toolCallId: "review-progress-call",
                type: "permission_review",
                userAuthorization: "low",
            }),
        );
        expect(
            store
                .elements()
                .find(
                    (element) =>
                        element.kind === "tool_call" &&
                        element.toolCallId === "review-progress-call",
                ),
        ).toMatchObject({
            permissionReview: {
                decision: "deny",
                reason: "The user did not authorize deployment.",
                risk: "high",
                status: "completed",
                toolCallId: "review-progress-call",
                userAuthorization: "low",
            },
        });
        store.apply(
            event("session_activity_changed", {
                activity: {
                    kind: "reviewing_tool_call",
                    label: "Reviewing exec_command",
                    reviewingToolCalls: [
                        {
                            action: "Deploy the service",
                            startedAt: 10,
                            toolCallId: "review-progress-call",
                            toolName: "exec_command",
                        },
                    ],
                    runId: "run-review-progress",
                    since: 10,
                },
            }),
        );
        expect(
            store
                .elements()
                .find(
                    (element) =>
                        element.kind === "tool_call" &&
                        element.toolCallId === "review-progress-call",
                ),
        ).toMatchObject({
            permissionReview: {
                decision: "deny",
                status: "completed",
                toolCallId: "review-progress-call",
            },
        });
        store.apply(
            event("agent_message", {
                message: {
                    blocks: [
                        { text: "Automatic permission review refused deployment.", type: "text" },
                    ],
                    context: "excluded",
                    id: "review-progress-error",
                    outcome: "continued",
                    role: "error",
                },
                runId: "run-review-progress",
            }),
        );
        expect(store.elements().at(-1)).toMatchObject({
            kind: "failure",
            outcome: "continued",
            reason: "Automatic permission review refused deployment.",
        });
    });

    it("clears an unfinished review when the tool is interrupted", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(
            event("agent_message", {
                message: {
                    blocks: [
                        {
                            arguments: { command: "deploy" },
                            id: "interrupted-review-call",
                            name: "exec_command",
                            type: "tool_call",
                        },
                    ],
                    id: "interrupted-review-message",
                    role: "agent",
                },
                runId: "run-interrupted-review",
            }),
        );
        store.apply(
            agentEvent({
                action: "Deploy the service",
                toolCallId: "interrupted-review-call",
                toolName: "exec_command",
                type: "permission_review_started",
            }),
        );

        store.apply(
            agentEvent({
                result: {
                    display: "Interrupted by user.",
                    failure: { kind: "interrupted" },
                    isError: true,
                    toolCallId: "interrupted-review-call",
                    toolName: "exec_command",
                },
                type: "tool_execution_end",
            }),
        );

        const interrupted = store
            .elements()
            .find(
                (element) =>
                    element.kind === "tool_call" &&
                    element.toolCallId === "interrupted-review-call",
            );
        expect(interrupted).toMatchObject({ status: "interrupted" });
        expect(interrupted).not.toHaveProperty("permissionReview");
    });

    it("clears an unfinished review when activity moves on without a verdict", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(
            event("agent_message", {
                message: {
                    blocks: [
                        {
                            arguments: { command: "deploy" },
                            id: "abandoned-review-call",
                            name: "exec_command",
                            type: "tool_call",
                        },
                    ],
                    id: "abandoned-review-message",
                    role: "agent",
                },
                runId: "run-abandoned-review",
            }),
        );
        store.apply(
            agentEvent({
                action: "Deploy the service",
                toolCallId: "abandoned-review-call",
                toolName: "exec_command",
                type: "permission_review_started",
            }),
        );

        store.apply(
            event("session_activity_changed", {
                activity: {
                    kind: "thinking",
                    label: "Thinking",
                    runId: "run-abandoned-review",
                    since: 11,
                },
            }),
        );

        const abandoned = store
            .elements()
            .find(
                (element) =>
                    element.kind === "tool_call" && element.toolCallId === "abandoned-review-call",
            );
        expect(abandoned).not.toHaveProperty("permissionReview");
    });

    it("restores an in-progress automatic review from current session activity", () => {
        const opening = hello();
        const toolMessage: Message = {
            blocks: [
                {
                    arguments: { command: "deploy" },
                    id: "reconnected-review-call",
                    name: "exec_command",
                    type: "tool_call",
                },
            ],
            id: "reconnected-review-message",
            role: "agent",
        };
        const activity = {
            kind: "reviewing_tool_call" as const,
            label: "Reviewing exec_command",
            reviewingToolCalls: [
                {
                    action: "Deploy the service",
                    startedAt: 10,
                    toolCallId: "reconnected-review-call",
                    toolName: "exec_command",
                },
            ],
            runId: "run-reconnected-review",
            since: 10,
        };
        const store = new ChatStore("session-1");
        store.applyHello({
            ...opening,
            activity,
            session: {
                ...opening.session!,
                activity,
                snapshot: { messages: [toolMessage] },
            },
            transcript: {
                complete: true,
                messages: [toolMessage],
                turns: [
                    {
                        messageIds: [toolMessage.id],
                        runId: "run-reconnected-review",
                        startedAt: 1,
                    },
                ],
            },
        });

        expect(store.session().activity).toEqual(activity);
        expect(
            store
                .elements()
                .find(
                    (element) =>
                        element.kind === "tool_call" &&
                        element.toolCallId === "reconnected-review-call",
                ),
        ).toMatchObject({
            permissionReview: {
                action: "Deploy the service",
                status: "reviewing",
                toolCallId: "reconnected-review-call",
            },
        });
    });

    it("atomically hands authoritative timing to a queued turn and records both wall clocks", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        const first = event("message_submitted", {
            delivery: "run",
            displayText: "First",
            message: {
                blocks: [{ text: "First", type: "text" }],
                id: "user-1",
                role: "user",
            },
            runId: "run-1",
        });
        const second = event("message_submitted", {
            delivery: "run",
            displayText: "Second",
            message: {
                blocks: [{ text: "Second", type: "text" }],
                id: "user-2",
                role: "user",
            },
            runId: "run-2",
        });
        store.apply(first);
        store.apply(event("run_started", { runId: "run-1" }));
        const inferenceStarted = event("agent_event", {
            event: { iteration: 1, messageId: "agent-1", type: "inference_iteration_start" },
            runId: "run-1",
        });
        store.apply(inferenceStarted);
        store.apply(second);

        expect(store.session()).toMatchObject({
            activeTurn: { runId: "run-1", startedAt: first.createdAt },
        });

        const finished = event("run_finished", {
            modelLocked: false,
            runId: "run-1",
            stopReason: "stop",
        });
        const deltas = store.apply(finished);

        expect(store.session()).toMatchObject({
            activeTurn: { runId: "run-2", startedAt: second.createdAt },
        });
        expect(deltas).not.toContainEqual(
            expect.objectContaining({
                session: expect.not.objectContaining({ activeTurn: expect.anything() }),
                type: "session_changed",
            }),
        );
        expect(
            store
                .elements()
                .find(
                    (element) =>
                        element.kind === "group_end" && element.groupId === "group:agent-1",
                ),
        ).toMatchObject({
            elapsedMs: finished.createdAt - inferenceStarted.createdAt,
            endedAt: finished.createdAt,
            kind: "group_end",
            startedAt: inferenceStarted.createdAt,
        });
    });

    it("ends a failed turn with an error outcome that carries the reason", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(event("run_started", { runId: "run-1" }));
        store.apply(
            agentEvent({ iteration: 1, messageId: "m1", type: "inference_iteration_start" }),
        );
        store.apply(event("run_error", { errorMessage: "The provider failed.", runId: "run-1" }));

        expect(store.elements().at(-1)).toMatchObject({
            errorMessage: "The provider failed.",
            kind: "group_end",
            outcome: "error",
        });
    });

    it("closes a tool call left open when a turn is stopped", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(event("run_started", { runId: "run-1" }));
        store.apply(
            agentEvent({ iteration: 1, messageId: "m1", type: "inference_iteration_start" }),
        );
        store.apply(
            agentEvent({
                toolCall: { arguments: {}, id: "call-1", name: "Bash", type: "tool_call" },
                type: "tool_execution_start",
            }),
        );
        store.apply(event("run_finished", { runId: "run-1", stopReason: "aborted" }));

        const call = store.elements().find((element) => element.kind === "tool_call");
        expect(call).toMatchObject({ status: "interrupted" });
        expect(store.elements().at(-1)).toMatchObject({ kind: "group_end", outcome: "stopped" });
    });

    it("grows text by delta instead of appending a second element", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(event("run_started", { runId: "run-1" }));
        store.apply(agentEvent({ contentIndex: 0, messageId: "m1", type: "text_start" }));
        store.apply(
            agentEvent({ contentIndex: 0, delta: "Hel", messageId: "m1", type: "text_delta" }),
        );
        store.apply(
            agentEvent({ contentIndex: 0, delta: "lo", messageId: "m1", type: "text_delta" }),
        );

        const texts = store.elements().filter((element) => element.kind === "agent_text");
        expect(texts).toHaveLength(1);
        expect(texts[0]).toMatchObject({ complete: false, text: "Hello" });
    });

    it("keeps the identity of elements that did not change", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(event("run_started", { runId: "run-1" }));
        store.apply(agentEvent({ contentIndex: 0, messageId: "m1", type: "text_start" }));
        store.apply(
            agentEvent({ contentIndex: 0, delta: "One", messageId: "m1", type: "text_delta" }),
        );
        store.apply(
            agentEvent({ content: "One", contentIndex: 0, messageId: "m1", type: "text_end" }),
        );
        const firstText = store.elements()[0] as ChatElement;

        store.apply(
            agentEvent({
                toolCall: { arguments: {}, id: "call-1", name: "Bash", type: "tool_call" },
                type: "tool_execution_start",
            }),
        );

        expect(store.elements()[0]).toBe(firstText);
    });

    it("gives a changed element a new reference so a consumer can tell it apart", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(event("run_started", { runId: "run-1" }));
        store.apply(agentEvent({ contentIndex: 0, messageId: "m1", type: "text_start" }));
        const before = store.elements()[0];

        store.apply(
            agentEvent({ contentIndex: 0, delta: "Hi", messageId: "m1", type: "text_delta" }),
        );

        expect(store.elements()[0]).not.toBe(before);
    });

    it("lands a tool result on the element that was already there", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        runOneTurn(store);

        const calls = store.elements().filter((element) => element.kind === "tool_call");
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ result: "3 files", status: "succeeded" });
    });

    it("reports a tool failure as a failed call rather than a separate element", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(event("run_started", { runId: "run-1" }));
        store.apply(
            agentEvent({
                toolCall: { arguments: {}, id: "call-1", name: "Bash", type: "tool_call" },
                type: "tool_execution_start",
            }),
        );
        store.apply(
            agentEvent({
                result: {
                    display: "No such file",
                    failure: { kind: "execution_failed" },
                    isError: true,
                    toolCallId: "call-1",
                    toolName: "Bash",
                },
                type: "tool_execution_end",
            }),
        );

        expect(store.elements().find((element) => element.kind === "tool_call")).toMatchObject({
            status: "failed",
        });
    });

    it("presents a command as one value that gains its output", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(event("run_started", { runId: "run-1" }));
        store.apply(
            agentEvent({
                toolCall: {
                    arguments: {},
                    id: "call-1",
                    name: "Bash",
                    presentation: { command: "ls -la", type: "exec_command" },
                    type: "tool_call",
                },
                type: "tool_execution_start",
            }),
        );

        // While it runs, the command is known and the output is not.
        expect(store.elements().find((element) => element.kind === "tool_call")).toMatchObject({
            presentation: { command: "ls -la", kind: "command" },
        });
        expect(
            (
                store.elements().find((element) => element.kind === "tool_call") as {
                    presentation?: { output?: string };
                }
            ).presentation?.output,
        ).toBeUndefined();

        store.apply(
            agentEvent({
                result: {
                    display: "done",
                    presentation: { command: "ls -la", output: "3 files", type: "exec_command" },
                    toolCallId: "call-1",
                    toolName: "Bash",
                },
                type: "tool_execution_end",
            }),
        );

        // The same kind, now with output: a UI does not swap one shape for
        // another halfway through.
        expect(store.elements().find((element) => element.kind === "tool_call")).toMatchObject({
            presentation: { command: "ls -la", kind: "command", output: "3 files" },
        });
    });

    it("presents exploration as steps a UI can render without decoding the wire", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(event("run_started", { runId: "run-1" }));
        store.apply(
            agentEvent({
                toolCall: {
                    arguments: {},
                    id: "call-1",
                    name: "Grep",
                    presentation: {
                        operations: [
                            { kind: "list", target: "sources" },
                            { kind: "read", name: "ChatStore.ts" },
                            { command: "rg todo", kind: "search", path: "sources", query: "todo" },
                        ],
                        type: "exploration",
                    },
                    type: "tool_call",
                },
                type: "tool_execution_start",
            }),
        );

        expect(store.elements().find((element) => element.kind === "tool_call")).toMatchObject({
            presentation: {
                kind: "exploration",
                steps: [
                    { kind: "list", target: "sources" },
                    { kind: "read", name: "ChatStore.ts" },
                    { command: "rg todo", kind: "search", path: "sources", query: "todo" },
                ],
            },
        });
    });

    it("presents a file edit as the diff it is", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(event("run_started", { runId: "run-1" }));
        store.apply(
            agentEvent({
                toolCall: { arguments: {}, id: "call-1", name: "Edit", type: "tool_call" },
                type: "tool_execution_start",
            }),
        );
        store.apply(
            agentEvent({
                result: {
                    display: "edited",
                    presentation: {
                        files: [{ hunks: [], kind: "update", path: "a.ts" }],
                        omittedFiles: 2,
                        type: "file_diff",
                    },
                    toolCallId: "call-1",
                    toolName: "Edit",
                },
                type: "tool_execution_end",
            }),
        );

        expect(store.elements().find((element) => element.kind === "tool_call")).toMatchObject({
            presentation: {
                files: [{ kind: "update", path: "a.ts" }],
                kind: "file_edit",
                omittedFiles: 2,
            },
        });
    });

    it("leaves a call unpresented when Rig described it in a way this library does not know", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(event("run_started", { runId: "run-1" }));
        store.apply(
            agentEvent({
                toolCall: {
                    arguments: {},
                    id: "call-1",
                    name: "Future",
                    presentation: { type: "something_new" } as never,
                    type: "tool_call",
                },
                type: "tool_execution_start",
            }),
        );

        // A newer daemon must not break an older client: the plain result text
        // stays the fallback rather than a half-understood shape leaking out.
        const element = store.elements().find((item) => item.kind === "tool_call") as {
            presentation?: unknown;
        };
        expect(element.presentation).toBeUndefined();
    });

    it("groups tool calls issued together and leaves a lone call ungrouped", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(event("run_started", { runId: "run-1" }));
        for (const id of ["call-1", "call-2"]) {
            store.apply(
                agentEvent({
                    toolCall: { arguments: {}, id, name: "Read", type: "tool_call" },
                    type: "tool_execution_start",
                }),
            );
        }

        const grouped = store
            .elements()
            .filter((e): e is ToolCallElement => e.kind === "tool_call");
        expect(grouped).toHaveLength(2);
        expect(grouped[0]?.toolCallGroupId).toBeDefined();
        expect(grouped[0]?.toolCallGroupId).toBe(grouped[1]?.toolCallGroupId);

        const single = new ChatStore("session-2");
        single.applyHello(hello());
        single.apply(event("run_started", { runId: "run-1" }));
        single.apply(
            agentEvent({
                toolCall: { arguments: {}, id: "only", name: "Read", type: "tool_call" },
                type: "tool_execution_start",
            }),
        );
        expect(
            (single.elements().find((e) => e.kind === "tool_call") as ToolCallElement)
                .toolCallGroupId,
        ).toBeUndefined();
    });

    it("shows compaction as an element that reflects its current state", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(event("run_started", { runId: "run-1" }));
        store.apply(
            agentEvent({
                compactionId: "c1",
                estimatedTokensBefore: 120_000,
                reason: "threshold",
                type: "context_compaction_started",
            }),
        );

        expect(store.elements().find((element) => element.kind === "compaction")).toMatchObject({
            estimatedTokensBefore: 120_000,
            status: "running",
        });

        store.apply(
            agentEvent({
                compactedMessageCount: 12,
                compactionId: "c1",
                estimatedTokensAfter: 40_000,
                estimatedTokensBefore: 120_000,
                type: "context_compacted",
            }),
        );
        store.apply(
            agentEvent({
                compactionId: "c1",
                elapsedMs: 900,
                status: "completed",
                type: "context_compaction_finished",
            }),
        );
        const compaction = {
            role: "compaction",
            id: "c1",
            blocks: [],
            providerId: "claude",
            replacedMessageIds: ["m1", "m2"],
            statistics: {
                after: { exact: false, tokens: 40_000 },
                before: { exact: true, tokens: 121_000 },
            },
        } satisfies Message;
        store.apply(event("agent_message", { message: compaction, runId: "run-1" }));

        expect(store.elements().filter((element) => element.kind === "compaction")).toHaveLength(1);
        expect(store.elements().find((element) => element.kind === "compaction")).toMatchObject({
            estimatedTokensAfter: 40_000,
            messagesCompacted: 2,
            status: "completed",
            tokensAfter: 40_000,
            tokensAfterExact: false,
            tokensBefore: 121_000,
        });

        store.apply(
            event("agent_message", {
                message: {
                    ...compaction,
                    statistics: {
                        ...compaction.statistics,
                        after: { exact: true, tokens: 41_000 },
                    },
                },
                runId: "run-1",
            }),
        );
        expect(store.elements().filter((element) => element.kind === "compaction")).toHaveLength(1);
        expect(store.elements().find((element) => element.kind === "compaction")).toMatchObject({
            tokensAfter: 41_000,
            tokensAfterExact: true,
        });
    });

    it("marks a standalone manual compaction as its own completed turn", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        const started = store.apply(event("run_started", { kind: "compaction", runId: "run-1" }));

        expect(store.session().activeTurn).toEqual({
            kind: "compaction",
            runId: "run-1",
            startedAt: clock,
        });
        expect(started).toContainEqual({
            kind: "compaction",
            runId: "run-1",
            startedAt: clock,
            type: "turn_started",
        });

        store.apply(
            event("run_finished", {
                modelLocked: false,
                runId: "run-1",
                stopReason: "stop",
            }),
        );

        expect(store.session().activeTurn).toBeUndefined();
        expect(store.elements().find((element) => element.kind === "group_end")).toMatchObject({
            outcome: "success",
            runId: "run-1",
            turnKind: "compaction",
        });

        const compaction = {
            blocks: [],
            id: "manual-compaction-message",
            providerId: "claude",
            replacedMessageIds: ["older-message"],
            role: "compaction",
            statistics: {
                after: { exact: false, tokens: 40 },
                before: { exact: true, tokens: 120 },
            },
        } satisfies Message;
        const opening = hello();
        const restored = new ChatStore("session-1");
        restored.applyHello({
            ...opening,
            session: {
                ...opening.session!,
                snapshot: { messages: [compaction] },
            },
            transcript: {
                complete: true,
                messages: [compaction],
                turns: [
                    {
                        endedAt: 20,
                        kind: "compaction",
                        messageIds: [compaction.id],
                        outcome: "success",
                        runId: "run-2",
                        startedAt: 10,
                    },
                ],
            },
        });
        expect(restored.elements().find((element) => element.kind === "group_end")).toMatchObject({
            runId: "run-2",
            turnKind: "compaction",
        });
    });

    it("emits ordered deltas for the turn, compaction, and retry lifecycle", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        const deltas = runOneTurn(store);

        const kinds = deltas.map((delta) => delta.type);
        expect(kinds.indexOf("turn_started")).toBeLessThan(kinds.indexOf("group_ended"));
        expect(deltas.at(-1)?.type).toBe("elements_changed");
    });

    it("retains a retry as a transcript element and reports its live lifecycle", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(event("run_started", { runId: "run-1" }));
        store.apply(
            agentEvent({ iteration: 1, messageId: "m1", type: "inference_iteration_start" }),
        );
        const started = store.apply(
            event("agent_message", {
                message: {
                    attempt: 2,
                    blocks: [{ text: "rate limited", type: "text" }],
                    id: "retry-2",
                    outcome: "retried",
                    role: "error",
                },
                runId: "run-1",
            }),
        );
        expect(started).toContainEqual({
            attempt: 2,
            reason: "rate limited",
            type: "retry_started",
        });
        expect(store.elements().at(-1)).toMatchObject({
            attempt: 2,
            id: "message:retry-2",
            kind: "failure",
            outcome: "retried",
            reason: "rate limited",
            runId: "run-1",
        });

        store.apply(
            event("session_activity_changed", {
                activity: {
                    kind: "retrying",
                    label: "Retrying: rate limited",
                    retry: { attempt: 2, reason: "rate limited" },
                    since: 1,
                },
            }),
        );

        const finished = store.apply(
            event("session_activity_changed", {
                activity: { kind: "thinking", label: "Thinking", since: 2 },
            }),
        );
        expect(finished.map((delta) => delta.type)).toContain("retry_finished");
    });

    it("never reports an unnumbered durable retry as attempt zero", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(event("run_started", { runId: "run-1" }));
        store.apply(
            agentEvent({ iteration: 1, messageId: "m1", type: "inference_iteration_start" }),
        );

        expect(
            store.apply(
                event("agent_message", {
                    message: {
                        blocks: [{ text: "connection lost", type: "text" }],
                        id: "retry-without-attempt",
                        outcome: "retried",
                        role: "error",
                    },
                    runId: "run-1",
                }),
            ),
        ).toContainEqual({
            attempt: 1,
            reason: "connection lost",
            type: "retry_started",
        });
    });

    it("reconciles a durable terminal error delivered after its run boundary", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(event("run_started", { runId: "run-1" }));
        store.apply(
            agentEvent({ iteration: 1, messageId: "m1", type: "inference_iteration_start" }),
        );
        store.apply(
            event("run_finished", {
                errorMessage: "Provider unavailable.",
                modelLocked: false,
                runId: "run-1",
                stopReason: "error",
            }),
        );
        store.apply(
            event("agent_message", {
                message: {
                    blocks: [{ text: "Provider unavailable.", type: "text" }],
                    id: "failure-1",
                    outcome: "failed",
                    role: "error",
                },
                runId: "run-1",
            }),
        );

        expect(
            store
                .elements()
                .filter(
                    (element) =>
                        element.kind === "failure" &&
                        element.outcome === "failed" &&
                        element.reason === "Provider unavailable.",
                ),
        ).toHaveLength(1);
    });

    it("renders the message a run is part-way through when a client attaches mid-turn", () => {
        const store = new ChatStore("session-1");
        store.applyHello(
            hello({
                activity: { kind: "generating_message", label: "Writing a reply", since: 5 },
                partial: {
                    message: {
                        blocks: [{ text: "Half a th", type: "text" }],
                        id: "m1",
                        role: "agent",
                    },
                    runId: "run-1",
                },
            }),
        );

        expect(store.elements().filter((element) => element.kind === "agent_text")).toMatchObject([
            { complete: false, text: "Half a th" },
        ]);
    });

    it("converges on the same list whether text arrived as deltas or as a whole message", () => {
        const streamed = new ChatStore("session-1");
        streamed.applyHello(hello());
        streamed.apply(event("run_started", { runId: "run-1" }));
        streamed.apply(
            agentEvent({ iteration: 1, messageId: "m1", type: "inference_iteration_start" }),
        );
        streamed.apply(agentEvent({ contentIndex: 0, messageId: "m1", type: "text_start" }));
        streamed.apply(
            agentEvent({ contentIndex: 0, delta: "Done.", messageId: "m1", type: "text_delta" }),
        );
        streamed.apply(
            event("agent_message", {
                message: { blocks: [{ text: "Done.", type: "text" }], id: "m1", role: "agent" },
                runId: "run-1",
            }),
        );

        const texts = streamed.elements().filter((element) => element.kind === "agent_text");
        expect(texts).toHaveLength(1);
        expect(texts[0]).toMatchObject({ complete: true, text: "Done." });
    });

    it("reconciles streamed text by its absolute block position", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(event("run_started", { runId: "run-1" }));
        store.apply(
            agentEvent({ iteration: 1, messageId: "m1", type: "inference_iteration_start" }),
        );
        store.apply(agentEvent({ contentIndex: 1, messageId: "m1", type: "text_start" }));
        store.apply(
            agentEvent({
                contentIndex: 1,
                delta: "One visible update.",
                messageId: "m1",
                type: "text_delta",
            }),
        );
        store.apply(
            event("agent_message", {
                message: {
                    blocks: [
                        { thinking: "Internal reasoning.", type: "thinking" },
                        { text: "One visible update.", type: "text" },
                    ],
                    id: "m1",
                    role: "agent",
                },
                runId: "run-1",
            }),
        );

        expect(store.elements().filter((element) => element.kind === "agent_text")).toMatchObject([
            { complete: true, text: "One visible update." },
        ]);
    });

    it("discards tentative text when the provider restarts the message", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(event("run_started", { runId: "run-1" }));
        store.apply(
            agentEvent({ iteration: 1, messageId: "m1", type: "inference_iteration_start" }),
        );
        store.apply(agentEvent({ contentIndex: 0, messageId: "m1", type: "text_start" }));
        store.apply(
            agentEvent({
                contentIndex: 0,
                delta: "Tentative",
                messageId: "m1",
                type: "text_delta",
            }),
        );
        expect(store.elements().filter((element) => element.kind === "agent_text")).toHaveLength(1);

        store.apply(agentEvent({ messageId: "m1", partial: {}, type: "block_reset" }));

        expect(store.elements().filter((element) => element.kind === "agent_text")).toHaveLength(0);
    });

    it("does not duplicate a message that is replayed after a reconnect", () => {
        const store = new ChatStore("session-1");
        store.applyHello({
            ...hello(),
            usage: {
                currentProviderId: "claude",
                groups: [],
                quotas: [],
                sessionTokenCount: { lastContextTokens: 0, totalTokens: 0 },
            },
        });
        store.apply(event("run_started", { runId: "run-1" }));
        const message = event("agent_message", {
            message: {
                blocks: [{ text: "Once.", type: "text" }],
                id: "m1",
                providerId: "claude",
                requestedModelId: "sonnet-5",
                role: "agent",
                usage: {
                    cacheRead: 0,
                    cacheWrite: 0,
                    cost: {
                        cacheRead: 0,
                        cacheWrite: 0,
                        input: 0,
                        output: 0,
                        total: 0,
                    },
                    input: 10,
                    output: 2,
                    totalTokens: 12,
                },
            },
            runId: "run-1",
        });
        store.apply(message);
        store.apply(message);

        expect(store.elements().filter((element) => element.kind === "agent_text")).toHaveLength(1);
        expect(store.session().usage?.totalTokens).toBe(12);
    });

    it("restores a running tool from current activity", () => {
        const store = new ChatStore("session-1");
        const toolMessage = {
            blocks: [
                {
                    arguments: { command: "pnpm test" },
                    id: "tool-1",
                    name: "Bash",
                    type: "tool_call" as const,
                },
            ],
            id: "agent-tool",
            role: "agent" as const,
        };

        store.applyHello(
            hello({
                activity: {
                    kind: "executing_tool_call",
                    label: "Running Bash",
                    since: 5,
                    toolCalls: [
                        {
                            startedAt: 5,
                            status: "Running tests",
                            toolCallId: "tool-1",
                            toolName: "Bash",
                        },
                    ],
                },
                session: {
                    ...hello().session!,
                    snapshot: { messages: [toolMessage] },
                },
                transcript: {
                    complete: true,
                    messages: [toolMessage],
                    turns: [
                        {
                            messageIds: ["agent-tool"],
                            runId: "run-1",
                            startedAt: 1,
                        },
                    ],
                },
            }),
        );

        expect(store.elements().find((element) => element.kind === "tool_call")).toMatchObject({
            progress: "Running tests",
            status: "running",
            toolCallId: "tool-1",
        });
    });

    it("rebuilds interleaved turns in their global message order", () => {
        const store = new ChatStore("session-1");
        const messages = [
            { blocks: [{ text: "u1", type: "text" as const }], id: "u1", role: "user" as const },
            { blocks: [{ text: "u2", type: "text" as const }], id: "u2", role: "user" as const },
            { blocks: [{ text: "a1", type: "text" as const }], id: "a1", role: "agent" as const },
            { blocks: [{ text: "a2", type: "text" as const }], id: "a2", role: "agent" as const },
        ];
        store.applyHello(
            hello({
                session: { ...hello().session!, snapshot: { messages } },
                transcript: {
                    complete: true,
                    messageCreatedAt: { a1: 3, a2: 5, u1: 1, u2: 2 },
                    messages,
                    turns: [
                        {
                            endedAt: 4,
                            messageIds: ["u1", "a1"],
                            outcome: "success",
                            runId: "run-1",
                            startedAt: 1,
                        },
                        {
                            endedAt: 6,
                            messageIds: ["u2", "a2"],
                            outcome: "success",
                            runId: "run-2",
                            startedAt: 2,
                        },
                    ],
                },
            }),
        );

        expect(
            store
                .elements()
                .filter(
                    (element) =>
                        element.kind === "user_message" ||
                        element.kind === "agent_text" ||
                        element.kind === "group_end",
                )
                .map((element) => `${element.kind}:${element.runId}`),
        ).toEqual([
            "user_message:run-1",
            "user_message:run-2",
            "agent_text:run-1",
            "group_end:run-1",
            "agent_text:run-2",
            "group_end:run-2",
        ]);
    });

    it("keeps the transcript untouched when a resume carries no session", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        runOneTurn(store);
        const before = store.elements();

        store.applyHello({
            activity: { kind: "idle", label: "Idle", since: 9 },
            resumed: true,
        });

        expect(store.elements()).toBe(before);
    });

    it("renders a non-internal system message as a system notice", () => {
        const store = new ChatStore("session-1");
        const opening = hello();
        store.applyHello({
            ...opening,
            session: {
                ...opening.session!,
                snapshot: {
                    messages: [
                        {
                            blocks: [{ text: "The environment restarted.", type: "text" }],
                            id: "system-1",
                            role: "system",
                        },
                    ],
                },
            },
        });

        expect(store.elements()).toMatchObject([
            {
                kind: "system_notice",
                text: "The environment restarted.",
            },
        ]);
    });

    it("keeps an interleaved compute notice outside the live run and rebuilds identically", () => {
        const message = {
            blocks: [
                {
                    text: "Preparing compute: waiting for the sandbox to start (45s)",
                    type: "text" as const,
                },
            ],
            context: "excluded" as const,
            id: "compute-notice-1",
            role: "system" as const,
            structured: {
                computeInstanceId: "compute-1",
                elapsedMs: 45_000,
                error: {
                    code: "preparing_compute" as const,
                    elapsedMs: 45_000,
                    lastProgressAt: 30_000,
                    message: "waiting for the sandbox to start",
                    percent: 40,
                    phase: "waiting_for_sandbox",
                    retryable: true as const,
                    startedAt: 10_000,
                    state: "unavailable" as const,
                },
                kind: "compute_preparation" as const,
                lastProgressAt: 30_000,
                message: "waiting for the sandbox to start",
                percent: 40,
                phase: "waiting_for_sandbox",
                provider: "daytona",
                startedAt: 10_000,
                state: "unavailable" as const,
            },
        };
        const toolMessage = {
            blocks: [
                {
                    arguments: { command: "ls" },
                    id: "call-1",
                    name: "Bash",
                    type: "tool_call" as const,
                },
            ],
            id: "m1",
            role: "agent" as const,
        };
        const started = event("run_started", { runId: "run-1" });
        const inferenceStarted = agentEvent({
            iteration: 1,
            messageId: toolMessage.id,
            type: "inference_iteration_start",
        });
        const committedTool = event("agent_message", {
            message: toolMessage,
            runId: "run-1",
        });
        const toolStarted = agentEvent({
            toolCall: {
                arguments: { command: "ls" },
                id: "call-1",
                name: "Bash",
                type: "tool_call",
            },
            type: "tool_execution_start",
        });
        const noticeEvent = event("system_notice", { message });
        const live = new ChatStore("session-1");
        live.applyHello(hello());
        for (const emitted of [
            started,
            inferenceStarted,
            committedTool,
            toolStarted,
            noticeEvent,
        ]) {
            live.apply(emitted);
        }
        live.setConnection("reconnecting");
        live.apply(noticeEvent);

        expect(live.session().activeGroup).toMatchObject({
            groupId: `group:${toolMessage.id}`,
            runId: "run-1",
        });
        expect(live.elements().filter((element) => element.kind === "group_end")).toEqual([]);
        expect(live.elements().find((element) => element.kind === "tool_call")).toMatchObject({
            status: "running",
        });
        expect(live.elements().filter((element) => element.kind === "system_notice")).toEqual([
            expect.objectContaining({
                groupId: `notice:${message.id}`,
                kind: "system_notice",
                structured: message.structured,
                text: "Preparing compute: waiting for the sandbox to start (45s)",
            }),
        ]);

        const rebuilt = new ChatStore("session-1");
        rebuilt.applyHello({
            ...hello(),
            activity: {
                kind: "executing_tool_call",
                label: "Running Bash",
                runId: "run-1",
                since: toolStarted.createdAt,
                toolCalls: [
                    {
                        startedAt: toolStarted.createdAt,
                        toolCallId: "call-1",
                        toolName: "Bash",
                    },
                ],
            },
            session: {
                ...hello().session!,
                activeTurn: { runId: "run-1", startedAt: started.createdAt },
            },
            transcript: {
                complete: true,
                messageCreatedAt: { [toolMessage.id]: committedTool.createdAt },
                messageEventId: { [toolMessage.id]: committedTool.id },
                messages: [toolMessage],
                notices: [
                    {
                        createdAt: noticeEvent.createdAt,
                        eventId: noticeEvent.id,
                        message,
                    },
                ],
                turns: [
                    {
                        groups: [{ id: toolMessage.id, startedAt: inferenceStarted.createdAt }],
                        messageIds: [toolMessage.id],
                        runId: "run-1",
                        startedAt: started.createdAt,
                    },
                ],
            },
        });
        rebuilt.apply(noticeEvent);

        expect(rebuilt.elements()).toEqual(live.elements());
        expect(
            rebuilt.elements().filter((element) => element.kind === "system_notice"),
        ).toHaveLength(1);
    });

    it("retains validated fallback text when a future structured notice kind is unknown", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());

        store.apply(
            event("system_notice", {
                message: {
                    blocks: [{ text: "A newer Rig service changed state.", type: "text" }],
                    context: "excluded",
                    id: "future-notice-1",
                    role: "system",
                    structured: {
                        kind: "future_service_notice",
                        machineOnly: true,
                    } as never,
                },
            }),
        );

        expect(store.elements()).toMatchObject([
            {
                kind: "system_notice",
                text: "A newer Rig service changed state.",
            },
        ]);
        expect(store.elements()[0]).not.toHaveProperty("structured");

        store.apply(
            event("system_notice", {
                message: {
                    blocks: [
                        {
                            text: "x".repeat(SERVICE_NOTICE_TEXT_MAX_LENGTH + 100),
                            type: "text",
                        },
                    ],
                    context: "excluded",
                    id: "future-notice-2",
                    role: "system",
                    structured: { kind: "future_service_notice" } as never,
                },
            }),
        );
        store.apply(
            event("system_notice", {
                message: {
                    blocks: [{ text: "A duplicate replay.", type: "text" }],
                    context: "excluded",
                    id: "future-notice-2",
                    role: "system",
                },
            }),
        );
        store.apply(
            event("system_notice", {
                message: {
                    blocks: [],
                    context: "excluded",
                    id: "future-notice-empty",
                    role: "system",
                },
            }),
        );
        store.apply(
            event("system_notice", {
                message: {
                    blocks: [{ text: "A late replay.", type: "text" }],
                    context: "excluded",
                    id: "future-notice-empty",
                    role: "system",
                },
            }),
        );

        expect(store.elements()).toHaveLength(2);
        expect(store.elements()[1]).toMatchObject({
            kind: "system_notice",
            text: "x".repeat(SERVICE_NOTICE_TEXT_MAX_LENGTH),
        });
        expect(store.elements()[1]).not.toHaveProperty("structured");
    });

    it("tracks live session facts without a follow-up request", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());

        store.apply(event("session_configuration_changed", { modelId: "opus-5" }));
        store.apply(
            event("session_git_changed", {
                git: { branch: "main", changedFiles: 3, files: [] },
            }),
        );
        store.apply(event("session_title_changed", { status: "ready", title: "Ship it" }));
        store.apply(
            event("session_context_changed", {
                sessionTokenCount: { lastContextTokens: 42_000, totalTokens: 90_000 },
            }),
        );

        expect(store.session()).toMatchObject({
            cwd: "/work",
            modelId: "opus-5",
            title: "Ship it",
            tokens: { lastContextTokens: 42_000, totalTokens: 90_000 },
        });
        expect(store.session().git).toMatchObject({ branch: "main", changedFiles: 3 });
    });

    it("does not let a late Git watch response replace a newer live snapshot", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        const snapshot = {
            changedFiles: 2,
            comparison: "ready" as const,
            conflicted: false,
            countsExact: true,
            deletions: 0,
            files: [],
            filesTruncated: false,
            generation: "generation-1",
            insertions: 2,
            scannedAt: 2,
            version: 2,
        };
        store.applyGitSnapshot(snapshot);
        const current = store.session();

        const deltas = store.applyGitSnapshot({
            ...snapshot,
            changedFiles: 1,
            scannedAt: 1,
            version: 1,
        });

        expect(deltas).toEqual([]);
        expect(store.session()).toBe(current);
        expect(store.session().git?.changedFiles).toBe(2);
    });

    it("reconciles non-replayable session facts from a resumed hello", () => {
        const store = new ChatStore("session-1");
        store.applyHello(
            hello({
                session: {
                    ...hello().session!,
                    draft: "stale",
                    git: {
                        branch: "stale",
                        changedFiles: 1,
                        comparison: "ready",
                        conflicted: false,
                        countsExact: true,
                        deletions: 0,
                        files: [],
                        filesTruncated: false,
                        generation: "old",
                        insertions: 1,
                        scannedAt: 1,
                        version: 1,
                    },
                    sessionTokenCount: { lastContextTokens: 1, totalTokens: 1 },
                },
            }),
        );

        store.applyHello({
            activity: { kind: "idle", label: "Idle", since: 2 },
            current: {
                draftUpdatedAt: 2,
                git: {
                    changedFiles: 2,
                    comparison: "ready",
                    conflicted: false,
                    countsExact: true,
                    deletions: 1,
                    facts: {
                        ahead: 0,
                        behind: 0,
                        branch: "main",
                        detached: false,
                    },
                    files: [],
                    filesTruncated: false,
                    generation: "new",
                    insertions: 2,
                    scannedAt: 2,
                    version: 2,
                },
                sessionTokenCount: { lastContextTokens: 42, totalTokens: 90 },
            },
            resumed: true,
        });

        expect(store.session()).toMatchObject({
            draftUpdatedAt: 2,
            git: { branch: "main", changedFiles: 2 },
            tokens: { lastContextTokens: 42, totalTokens: 90 },
        });
        expect(store.session().draft).toBeUndefined();
    });

    it("ignores an event it does not recognise", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        const before = store.elements();

        expect(store.apply(event("something_new", { whatever: true }))).toEqual([]);
        expect(store.elements()).toBe(before);
    });

    describe("live session facts", () => {
        it("initializes the complete application state from the opening frame", () => {
            const store = new ChatStore("session-1");
            const opening = hello();
            store.applyHello({
                ...opening,
                session: {
                    ...opening.session!,
                    archived: true,
                    backgroundProcesses: [
                        {
                            command: "pnpm test",
                            cwd: "/work",
                            sessionId: 7,
                            status: "running",
                        },
                    ],
                    draft: "Keep this",
                    draftUpdatedAt: 11,
                    effort: "high",
                    goal: {
                        createdAt: 1,
                        objective: "Ship it",
                        status: "active",
                        updatedAt: 2,
                    },
                    modelLocked: true,
                    models: [
                        {
                            defaultThinkingLevel: "medium",
                            id: "sonnet-5",
                            name: "Sonnet 5",
                            thinkingLevels: ["low", "medium", "high"],
                        },
                    ],
                    orderKey: "b0",
                    pendingSteeringMessages: [
                        {
                            createdAt: 10,
                            message: {
                                blocks: [{ text: "Also check this", type: "text" }],
                                id: "steer-1",
                                role: "user",
                            },
                            runId: "run-1",
                        },
                    ],
                    pendingUserInputs: [
                        {
                            questions: [
                                {
                                    header: "Choice",
                                    id: "choice",
                                    multiSelect: false,
                                    options: [{ description: "Use it", label: "Yes" }],
                                    question: "Proceed?",
                                },
                            ],
                            requestId: "input-1",
                        },
                    ],
                    permissionMode: "read_only",
                    projectId: "project-1",
                    recap: "Ready to ship",
                    serviceTier: "priority",
                    subagents: [
                        {
                            agentId: "agent-2",
                            createdAt: 1,
                            depth: 1,
                            description: "Review",
                            id: "session-2",
                            modelId: "sonnet-5",
                            parentSessionId: "session-1",
                            status: "idle",
                            updatedAt: 2,
                        },
                    ],
                    tasks: [
                        {
                            blockedBy: [],
                            blocks: [],
                            description: "Run tests",
                            id: "task-1",
                            status: "in_progress",
                            subject: "Verify",
                        },
                    ],
                    workspaceId: "workspace-1",
                },
            });

            expect(store.session()).toMatchObject({
                archived: true,
                backgroundProcesses: [{ sessionId: 7 }],
                draft: "Keep this",
                draftUpdatedAt: 11,
                effort: "high",
                goal: { objective: "Ship it" },
                modelLocked: true,
                models: [{ id: "sonnet-5" }],
                orderKey: "b0",
                pendingSteeringMessages: [{ runId: "run-1" }],
                pendingUserInputs: [{ requestId: "input-1" }],
                permissionMode: "read_only",
                projectId: "project-1",
                recap: "Ready to ship",
                serviceTier: "priority",
                subagents: [{ id: "session-2" }],
                tasks: [{ id: "task-1" }],
                workspaceId: "workspace-1",
            });
        });

        it("keeps application state current from complete live events", () => {
            const store = new ChatStore("session-1");
            store.applyHello(hello());

            store.apply(
                event("session_draft_changed", {
                    draft: "Draft",
                    origin: "happy",
                    updatedAt: 10,
                }),
            );
            store.apply(
                event("user_input_requested", {
                    questions: [],
                    requestId: "input-1",
                }),
            );
            store.apply(
                event("tasks_changed", {
                    tasks: [
                        {
                            blockedBy: [],
                            blocks: [],
                            description: "Run tests",
                            id: "task-1",
                            status: "pending",
                            subject: "Verify",
                        },
                    ],
                }),
            );
            store.apply(
                event("goal_changed", {
                    goal: {
                        createdAt: 1,
                        objective: "Ship",
                        status: "active",
                        updatedAt: 1,
                    },
                }),
            );
            store.apply(
                event("subagent_changed", {
                    subagent: {
                        agentId: "agent-2",
                        createdAt: 1,
                        depth: 1,
                        description: "Review",
                        id: "session-2",
                        modelId: "sonnet-5",
                        parentSessionId: "session-1",
                        status: "running",
                        updatedAt: 2,
                    },
                }),
            );
            store.apply(
                event("shell_command_started", {
                    command: "pnpm test",
                    commandId: "command-1",
                    sessionId: 8,
                }),
            );
            store.apply(
                event("message_submitted", {
                    delivery: "steer",
                    displayText: "Check this",
                    message: {
                        blocks: [{ text: "Check this", type: "text" }],
                        id: "steer-1",
                        role: "user",
                    },
                    runId: "run-1",
                }),
            );
            store.apply(
                agentEvent({
                    processes: [
                        {
                            command: "pnpm dev",
                            cwd: "/work",
                            sessionId: 9,
                            status: "running",
                        },
                    ],
                    running: 1,
                    type: "background_processes_changed",
                }),
            );
            store.apply(
                agentEvent({
                    toolCall: {
                        arguments: { command: "pnpm test" },
                        id: "call-1",
                        name: "exec_command",
                        type: "tool_call",
                    },
                    type: "tool_execution_start",
                }),
            );
            store.apply(
                agentEvent({
                    action: "Run tests",
                    decision: "allow",
                    reason: "The user asked for verification.",
                    risk: "low",
                    toolCallId: "call-1",
                    type: "permission_review",
                    userAuthorization: "high",
                }),
            );
            store.apply(
                agentEvent({
                    action: "Run tests",
                    reason: "The user asked for verification.",
                    risk: "low",
                    toolCallId: "call-1",
                    type: "temporary_full_access_started",
                    userAuthorization: "high",
                }),
            );

            expect(store.session()).toMatchObject({
                backgroundProcesses: [{ sessionId: 9 }],
                draft: "Draft",
                draftUpdatedAt: 10,
                goal: { objective: "Ship" },
                pendingSteeringMessages: [{ message: { id: "steer-1" } }],
                pendingUserInputs: [{ requestId: "input-1" }],
                permissionReviews: [
                    {
                        action: "Run tests",
                        decision: "allow",
                        fullAccessGranted: true,
                        reason: "The user asked for verification.",
                        risk: "low",
                        toolCallId: "call-1",
                        userAuthorization: "high",
                    },
                ],
                shellCommands: [{ commandId: "command-1", status: "running" }],
                subagents: [{ id: "session-2", status: "running" }],
                tasks: [{ id: "task-1" }],
            });
            expect(store.elements().find((element) => element.kind === "tool_call")).toMatchObject({
                permissionReview: {
                    action: "Run tests",
                    decision: "allow",
                    fullAccessGranted: true,
                    reason: "The user asked for verification.",
                    risk: "low",
                    userAuthorization: "high",
                },
            });

            store.apply(
                event("shell_command_finished", {
                    command: "pnpm test",
                    commandId: "command-1",
                    exitCode: 0,
                    output: "passed",
                    sessionId: 8,
                    timedOut: false,
                }),
            );
            store.apply(event("steering_applied", { messageIds: ["steer-1"], runId: "run-1" }));
            store.apply(
                event("user_input_resolved", {
                    requestId: "input-1",
                    status: "cancelled",
                }),
            );
            store.apply(event("goal_changed", { goal: null }));

            expect(store.session().shellCommands).toMatchObject([
                { commandId: "command-1", status: "finished" },
            ]);
            expect(store.session().pendingSteeringMessages).toEqual([]);
            expect(store.session().pendingUserInputs).toEqual([]);
            expect(store.session().goal).toBeUndefined();
        });

        it("preserves a title while metadata is generating or reports an error", () => {
            const store = new ChatStore("session-1");
            store.applyHello(hello());
            store.apply(event("session_title_changed", { status: "ready", title: "Ship it" }));

            store.apply(event("session_title_changed", { status: "generating" }));
            expect(store.session().title).toBe("Ship it");

            store.apply(
                event("session_title_changed", {
                    errorMessage: "Could not refresh metadata.",
                    status: "error",
                }),
            );
            expect(store.session().title).toBe("Ship it");
        });

        it("removes a title when the daemon settles without one", () => {
            const store = new ChatStore("session-1");
            store.applyHello(hello());
            store.apply(event("session_title_changed", { status: "ready", title: "Ship it" }));

            store.apply(event("session_title_changed", { status: "idle" }));

            expect(store.session().title).toBeUndefined();
        });

        it("tracks effort, service tier, and permission mode", () => {
            const store = new ChatStore("session-1");
            store.applyHello(hello());

            store.apply(
                event("session_configuration_changed", {
                    changed: ["model"],
                    effort: "high",
                    modelId: "opus-5",
                    serviceTier: "priority",
                }),
            );
            store.apply(event("permission_mode_changed", { permissionMode: "read_only" }));

            expect(store.session()).toMatchObject({
                effort: "high",
                modelId: "opus-5",
                permissionMode: "read_only",
                serviceTier: "priority",
            });
        });

        it("clears effort and service tier when the session no longer has them", () => {
            const store = new ChatStore("session-1");
            store.applyHello(hello());
            store.apply(
                event("session_configuration_changed", {
                    changed: ["model"],
                    effort: "high",
                    modelId: "opus-5",
                    serviceTier: "priority",
                }),
            );

            store.apply(
                event("session_configuration_changed", {
                    changed: ["model"],
                    modelId: "sonnet-5",
                    serviceTier: null,
                }),
            );

            expect(store.session().effort).toBeUndefined();
            expect(store.session().serviceTier).toBeUndefined();
        });
    });

    describe("what a turn cost", () => {
        function usage(input: number, output: number, cost: number) {
            return {
                cacheRead: 0,
                cacheWrite: 0,
                cost: { cacheRead: 0, cacheWrite: 0, input: cost, output: 0, total: cost },
                input,
                output,
                totalTokens: input + output,
            };
        }

        it("opens with complete session usage and derives panel totals", () => {
            const store = new ChatStore("session-1");
            store.applyHello({
                ...hello(),
                usage: {
                    currentProviderId: "claude",
                    groups: [
                        {
                            kind: "attributed",
                            modelId: "sonnet-5",
                            providerId: "claude",
                            requestedModelId: "sonnet-5",
                            usage: usage(100, 20, 0.5),
                        },
                    ],
                    quotas: [],
                    sessionTokenCount: { lastContextTokens: 120, totalTokens: 120 },
                },
            });

            expect(store.session().usage).toMatchObject({
                currentProviderId: "claude",
                totalCost: 0.5,
                totalTokens: 120,
            });
        });

        it("keeps session usage, context, and provider quota current from stream events", () => {
            const store = new ChatStore("session-1");
            store.applyHello({
                ...hello(),
                usage: {
                    currentProviderId: "claude",
                    groups: [],
                    quotas: [],
                    sessionTokenCount: { lastContextTokens: 0, totalTokens: 0 },
                },
            });
            store.apply(event("run_started", { runId: "run-1" }));
            store.apply(
                event("agent_message", {
                    message: {
                        blocks: [{ text: "Done", type: "text" }],
                        id: "m-usage",
                        providerId: "claude",
                        requestedModelId: "sonnet-5",
                        role: "agent",
                        usage: usage(200, 30, 0.75),
                        contextTokens: 211,
                    },
                    runId: "run-1",
                }),
            );

            store.apply(
                event("provider_quota_observed", {
                    providerId: "claude",
                    quota: {
                        capturedAt: 9,
                        source: "claude",
                        windows: {
                            fiveHour: {
                                capturedAt: 9,
                                resetsAt: 20,
                                status: "available",
                                usedPercent: 20,
                            },
                        },
                    },
                }),
            );
            store.apply(
                event("provider_quota_observed", {
                    providerId: "claude",
                    quota: {
                        capturedAt: 10,
                        source: "claude",
                        windows: {
                            fiveHour: {
                                capturedAt: 10,
                                resetsAt: 20,
                                status: "available",
                                usedPercent: 25,
                            },
                        },
                    },
                }),
            );

            expect(store.session().usage).toMatchObject({
                context: { approximate: false, totalTokens: 211 },
                currentProviderId: "claude",
                quotas: [
                    {
                        providerId: "claude",
                        quota: { capturedAt: 10, windows: { fiveHour: { usedPercent: 25 } } },
                    },
                ],
                totalCost: 0.75,
                totalTokens: 230,
            });

            store.apply(
                event("agent_event", {
                    event: {
                        compactedMessageCount: 2,
                        compactionId: "compact-1",
                        elapsedMs: 10,
                        estimatedTokensAfter: 80,
                        estimatedTokensBefore: 211,
                        reason: "threshold",
                        type: "context_compacted",
                    },
                    runId: "run-1",
                }),
            );
            const compactionMessage = {
                blocks: [{ text: "Compacted.", type: "text" }] as const,
                content: "checkpoint",
                id: "compact-1",
                kind: "native" as const,
                providerId: "claude",
                requestedModelId: "sonnet-5",
                replacedMessageIds: [],
                role: "compaction" as const,
                statistics: {
                    after: { exact: false, tokens: 80 },
                    before: { exact: true, tokens: 211 },
                },
                summary: "Compacted.",
                usage: usage(50, 10, 0.2),
            };
            store.apply(
                event("agent_message", {
                    message: compactionMessage,
                    runId: "run-1",
                }),
            );
            store.apply(
                event("agent_message", {
                    message: {
                        ...compactionMessage,
                        statistics: {
                            ...compactionMessage.statistics,
                            after: { exact: true, tokens: 80 },
                        },
                    },
                    runId: "run-1",
                }),
            );

            expect(store.session().usage).toMatchObject({
                context: { approximate: true, totalTokens: 80 },
                totalCost: 0.95,
                totalTokens: 290,
            });
        });

        it("clears context attribution immediately when the model changes", () => {
            const store = new ChatStore("session-1");
            store.applyHello({
                ...hello(),
                usage: {
                    context: {
                        approximate: false,
                        modelId: "sonnet-5",
                        providerId: "claude",
                        requestedModelId: "sonnet-5",
                        totalTokens: 100,
                    },
                    currentProviderId: "claude",
                    groups: [],
                    quotas: [],
                    sessionTokenCount: { lastContextTokens: 100, totalTokens: 100 },
                },
            });

            store.apply(
                event("session_configuration_changed", {
                    changed: ["model"],
                    modelId: "opus-5",
                    providerId: "claude",
                    serviceTier: null,
                }),
            );

            expect(store.session().usage?.context).toBeUndefined();
        });

        it("reports the usage of the turn on the element that ends it", () => {
            const store = new ChatStore("session-1");
            store.applyHello(hello());

            store.apply(event("run_started", { runId: "run-1" }));
            store.apply(
                event("agent_message", {
                    message: {
                        blocks: [{ text: "Done", type: "text" }],
                        id: "m1",
                        role: "agent",
                        usage: usage(100, 20, 0.5),
                    },
                    runId: "run-1",
                }),
            );
            store.apply(event("run_finished", { runId: "run-1", stopReason: "stop" }));

            const end = store.elements().at(-1);
            expect(end?.kind).toBe("group_end");
            expect(end).toMatchObject({
                usage: { input: 100, output: 20, totalTokens: 120 },
            });
        });

        it("adds up every inference the group needed, and starts over at the next one", () => {
            const store = new ChatStore("session-1");
            store.applyHello(hello());

            // A run that calls tools reaches the model more than once, and all
            // of it answers one question, so one footer states what it cost.
            store.apply(event("run_started", { runId: "run-1" }));
            for (const [index, tokens] of [100, 250].entries()) {
                store.apply(
                    event("agent_message", {
                        message: {
                            blocks: [{ text: `Step ${index}`, type: "text" }],
                            id: `m${index}`,
                            role: "agent",
                            usage: usage(tokens, 10, 0.25),
                        },
                        runId: "run-1",
                    }),
                );
            }
            store.apply(
                event("message_submitted", {
                    delivery: "steer",
                    displayText: "Actually, stop there",
                    message: {
                        blocks: [{ text: "Actually, stop there", type: "text" }],
                        id: "steer-1",
                        role: "user",
                    },
                    runId: "run-1",
                }),
            );
            store.apply(event("steering_applied", { messageIds: ["steer-1"], runId: "run-1" }));
            store.apply(
                event("agent_message", {
                    message: {
                        blocks: [{ text: "After steering", type: "text" }],
                        id: "m2",
                        role: "agent",
                        usage: usage(70, 10, 0.25),
                    },
                    runId: "run-1",
                }),
            );
            store.apply(event("run_finished", { runId: "run-1", stopReason: "stop" }));

            const ends = store.elements().filter((element) => element.kind === "group_end");
            expect(ends.map((element) => element.reason)).toEqual(["steering", "completed"]);
            expect(ends[0]).toMatchObject({
                usage: { input: 350, output: 20, totalTokens: 370 },
            });
            expect(ends[1]).toMatchObject({
                usage: { input: 70, output: 10, totalTokens: 80 },
            });
        });

        it("leaves the cost off a turn the daemon never reported one for", () => {
            const store = new ChatStore("session-1");
            store.applyHello(hello());
            runOneTurn(store);

            const end = store.elements().at(-1);
            expect(end?.kind).toBe("group_end");
            // Reporting zero would claim the turn was free, which is a different
            // statement from not knowing.
            expect((end as { usage?: unknown }).usage).toBeUndefined();
        });

        it("does not carry one turn's cost into the next", () => {
            const store = new ChatStore("session-1");
            store.applyHello(hello());

            store.apply(event("run_started", { runId: "run-1" }));
            store.apply(
                event("agent_message", {
                    message: {
                        blocks: [{ text: "First", type: "text" }],
                        id: "m1",
                        role: "agent",
                        usage: usage(100, 20, 0.5),
                    },
                    runId: "run-1",
                }),
            );
            store.apply(event("run_finished", { runId: "run-1", stopReason: "stop" }));

            store.apply(event("run_started", { runId: "run-2" }));
            store.apply(
                event("agent_message", {
                    message: {
                        blocks: [{ text: "Second", type: "text" }],
                        id: "m2",
                        role: "agent",
                        usage: usage(7, 3, 0.1),
                    },
                    runId: "run-2",
                }),
            );
            store.apply(event("run_finished", { runId: "run-2", stopReason: "stop" }));

            const ends = store.elements().filter((element) => element.kind === "group_end");
            expect(ends).toHaveLength(2);
            expect(ends[1]).toMatchObject({ usage: { input: 7, output: 3, totalTokens: 10 } });
        });
    });

    describe("history rebuilt from reported turns", () => {
        const messages = [
            { blocks: [{ text: "First ask", type: "text" }], id: "u1", role: "user" },
            { blocks: [{ text: "First answer", type: "text" }], id: "a1", role: "agent" },
            { blocks: [{ text: "Second ask", type: "text" }], id: "u2", role: "user" },
            { blocks: [{ text: "Second answer", type: "text" }], id: "a2", role: "agent" },
        ] as const;

        function withTurns(overrides: Partial<SessionStreamHello> = {}): SessionStreamHello {
            const base = hello();
            return {
                ...base,
                session: { ...base.session!, snapshot: { messages: [...messages] } },
                transcript: {
                    complete: true,
                    messages: [...messages],
                    turns: [
                        {
                            endedAt: 1_500,
                            messageIds: ["u1", "a1"],
                            outcome: "success",
                            runId: "run-1",
                            startedAt: 1_000,
                        },
                        {
                            endedAt: 2_800,
                            errorMessage: "It broke",
                            messageIds: ["u2", "a2"],
                            outcome: "error",
                            runId: "run-2",
                            startedAt: 2_000,
                        },
                    ],
                },
                ...overrides,
            };
        }

        it("closes every historical turn, as the live path does", () => {
            const store = new ChatStore("session-1");
            store.applyHello(withTurns());

            // The advertised guarantee is that a turn always ends with a final
            // element. History that was never watched live must honour it too,
            // including the line the second turn's failure earns before it.
            expect(store.elements().map((element) => element.kind)).toEqual([
                "user_message",
                "agent_text",
                "group_end",
                "user_message",
                "agent_text",
                "failure",
                "group_end",
            ]);
        });

        it("attributes historical elements to the run they belong to", () => {
            const store = new ChatStore("session-1");
            store.applyHello(withTurns());

            expect(store.elements().map((element) => element.runId)).toEqual([
                "run-1",
                "run-1",
                "run-1",
                "run-2",
                "run-2",
                "run-2",
                "run-2",
            ]);
        });

        it("keeps every historical steering message at its own time inside one turn", () => {
            const store = new ChatStore("session-1");
            const base = hello();
            const userMessages = [
                {
                    blocks: [{ text: "Initial request", type: "text" as const }],
                    id: "initial",
                    role: "user" as const,
                },
                ...Array.from({ length: 4 }, (_, index) => ({
                    blocks: [{ text: `Steering ${String(index + 1)}`, type: "text" as const }],
                    id: `steering-${String(index + 1)}`,
                    role: "user" as const,
                })),
            ];
            const answer = {
                blocks: [{ text: "Finished", type: "text" as const }],
                id: "answer",
                role: "agent" as const,
            };
            const transcriptMessages = [...userMessages, answer];
            store.applyHello({
                ...base,
                session: { ...base.session!, snapshot: { messages: [] } },
                transcript: {
                    complete: true,
                    messageCreatedAt: Object.fromEntries(
                        transcriptMessages.map((message, index) => [
                            message.id,
                            1_000 + index * 1_000,
                        ]),
                    ),
                    messageSteeredAt: {
                        "steering-1": 2_500,
                        "steering-2": 3_600,
                        "steering-3": 4_700,
                        "steering-4": 5_800,
                    },
                    messages: transcriptMessages,
                    turns: [
                        {
                            endedAt: 7_000,
                            messageIds: transcriptMessages.map((message) => message.id),
                            outcome: "success",
                            runId: "one-run",
                            startedAt: 1_000,
                        },
                    ],
                },
            });

            const rebuiltUsers = store
                .elements()
                .filter((element) => element.kind === "user_message");
            expect(rebuiltUsers.map((element) => element.createdAt)).toEqual([
                1_000, 2_000, 3_000, 4_000, 5_000,
            ]);
            expect(
                rebuiltUsers.map((element) => ({
                    elapsedMs: element.steeringElapsedMs,
                    steeredAt: element.steeredAt,
                })),
            ).toEqual([
                { elapsedMs: undefined, steeredAt: undefined },
                { elapsedMs: 1_500, steeredAt: 2_500 },
                { elapsedMs: 1_100, steeredAt: 3_600 },
                { elapsedMs: 1_100, steeredAt: 4_700 },
                { elapsedMs: 1_100, steeredAt: 5_800 },
            ]);
            expect(rebuiltUsers.every((element) => element.runId === "one-run")).toBe(true);
            expect(store.elements().filter((element) => element.kind === "group_end")).toEqual([
                expect.objectContaining({ endedAt: 7_000, runId: "one-run" }),
            ]);
        });

        it("keeps each historical message's own occurrence time", () => {
            const store = new ChatStore("session-1");
            const opening = withTurns();
            store.applyHello({
                ...opening,
                transcript: {
                    ...opening.transcript!,
                    messageCreatedAt: {
                        a1: 1_400,
                        a2: 2_700,
                        u1: 1_050,
                        u2: 2_100,
                    },
                },
            });

            const messages = store
                .elements()
                .filter(
                    (element) => element.kind === "user_message" || element.kind === "agent_text",
                );
            expect(messages.map((element) => element.createdAt)).toEqual([
                1_050, 1_400, 2_100, 2_700,
            ]);
        });

        it("reports the real outcome and duration of a historical turn", () => {
            const store = new ChatStore("session-1");
            store.applyHello(withTurns());

            const ends = store.elements().filter((element) => element.kind === "group_end");
            expect(ends[0]).toMatchObject({
                elapsedMs: 500,
                endedAt: 1_500,
                outcome: "success",
                startedAt: 1_000,
            });
            expect(ends[1]).toMatchObject({
                endedAt: 2_800,
                errorMessage: "It broke",
                outcome: "error",
                startedAt: 2_000,
            });
        });

        it("rebuilds durable retries in their historical group and time", () => {
            const store = new ChatStore("session-1");
            const opening = withTurns();
            const retry = {
                attempt: 1,
                blocks: [{ text: "Connection lost", type: "text" }],
                id: "retry-1",
                outcome: "retried",
                role: "error",
            } as const;
            store.applyHello({
                ...opening,
                transcript: {
                    ...opening.transcript!,
                    messageCreatedAt: {
                        a1: 1_200,
                        a2: 2_700,
                        "retry-1": 1_200,
                        u1: 1_050,
                        u2: 2_100,
                    },
                    messageEventId: {
                        a1: "018bcfe5-6800-7002-8000-00000000aaaa",
                        "retry-1": "018bcfe5-6800-7001-8000-00000000aaaa",
                    },
                    messageGroupId: { "retry-1": "a1" },
                    messages: [messages[0], retry, ...messages.slice(1)],
                    turns: [
                        {
                            ...opening.transcript!.turns[0]!,
                            groups: [
                                {
                                    endedAt: 1_500,
                                    id: "a1",
                                    outcome: "success",
                                    reason: "completed",
                                    startedAt: 1_200,
                                },
                            ],
                            messageIds: ["u1", "retry-1", "a1"],
                        },
                        opening.transcript!.turns[1]!,
                    ],
                },
            });

            const failure = store
                .elements()
                .find(
                    (element) => element.kind === "failure" && element.reason === "Connection lost",
                );
            const answer = store.elements().find((element) => element.kind === "agent_text");
            expect(failure).toMatchObject({ createdAt: 1_200, outcome: "retried" });
            expect(failure?.groupId).toBe(answer?.groupId);
        });

        it("leaves a turn that is still running open for live events to finish", () => {
            const store = new ChatStore("session-1");
            const base = withTurns();
            store.applyHello({
                ...base,
                transcript: {
                    ...base.transcript!,
                    turns: [
                        base.transcript!.turns[0]!,
                        { messageIds: ["u2", "a2"], runId: "run-2", startedAt: 2_000 },
                    ],
                },
            });

            const kinds = store.elements().map((element) => element.kind);
            expect(kinds.filter((kind) => kind === "group_end")).toHaveLength(1);
            expect(kinds.at(-1)).toBe("agent_text");
            expect(store.session().activeTurn).toEqual({
                runId: "run-2",
                startedAt: 2_000,
            });

            store.apply(
                event("session_activity_changed", {
                    activity: { kind: "tool", label: "Running a tool", since: 90_000 },
                }),
            );
            expect(store.session().activeTurn).toEqual({
                runId: "run-2",
                startedAt: 2_000,
            });
        });

        it("reports what a historical turn cost, as the live path does", () => {
            const store = new ChatStore("session-1");
            const base = withTurns();
            const priced = [
                base.transcript!.messages[0]!,
                {
                    ...(base.transcript!.messages[1] as object),
                    usage: {
                        cacheRead: 0,
                        cacheWrite: 0,
                        cost: { cacheRead: 0, cacheWrite: 0, input: 0.3, output: 0, total: 0.3 },
                        input: 90,
                        output: 10,
                        totalTokens: 100,
                    },
                },
                base.transcript!.messages[2]!,
                base.transcript!.messages[3]!,
            ] as NonNullable<typeof base.transcript>["messages"];

            store.applyHello({
                ...base,
                session: { ...base.session!, snapshot: { messages: [...priced] } },
                transcript: { ...base.transcript!, messages: priced },
            });

            const ends = store.elements().filter((element) => element.kind === "group_end");
            expect(ends[0]).toMatchObject({ usage: { input: 90, totalTokens: 100 } });
            // The second turn was never priced, so it must not inherit the first.
            expect((ends[1] as { usage?: unknown }).usage).toBeUndefined();
        });

        it("tells the caller when older turns exist beyond the window", () => {
            const store = new ChatStore("session-1");
            const base = withTurns();
            store.applyHello({
                ...base,
                transcript: { ...base.transcript!, complete: false },
            });

            expect(store.session().transcriptComplete).toBe(false);
        });

        it("treats a transcript with no reported turns as complete", () => {
            const store = new ChatStore("session-1");
            store.applyHello(hello());

            expect(store.session().transcriptComplete).toBe(true);
        });
    });

    it("keeps completed turns when a rewind starts a new context", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        runOneTurn(store);

        store.apply(
            event("session_rewound", {
                messageId: "m1",
                snapshot: {
                    messages: [
                        { blocks: [{ text: "Start over", type: "text" }], id: "u1", role: "user" },
                    ],
                },
            }),
        );
        store.apply(event("run_started", { runId: "run-2" }));
        store.apply(
            agentEvent({ iteration: 1, messageId: "m2", type: "inference_iteration_start" }),
        );
        store.apply(agentEvent({ contentIndex: 0, messageId: "m2", type: "text_start" }));
        store.apply(
            agentEvent({ contentIndex: 0, delta: "Again", messageId: "m2", type: "text_delta" }),
        );

        expect(store.elements()).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    complete: true,
                    kind: "agent_text",
                    text: "Let me check.",
                }),
                expect.objectContaining({
                    complete: false,
                    kind: "agent_text",
                    text: "Again",
                }),
            ]),
        );
    });

    it("does not remove a completed turn when a session is rewound", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        runOneTurn(store);

        store.apply(
            event("session_rewound", {
                messageId: "m1",
                snapshot: {
                    messages: [
                        { blocks: [{ text: "Start over", type: "text" }], id: "u1", role: "user" },
                    ],
                },
            }),
        );

        expect(store.elements()).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    complete: true,
                    kind: "agent_text",
                    text: "Let me check.",
                }),
                expect.objectContaining({ kind: "group_end", runId: "run-1" }),
            ]),
        );
    });

    it("rebuilds authoritative active timing when the session is reset", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        const message = {
            blocks: [{ text: "Continue", type: "text" as const }],
            id: "u-reset",
            role: "user" as const,
        };
        store.apply(
            event("session_reset", {
                snapshot: { messages: [message] },
                transcript: {
                    complete: true,
                    messages: [message],
                    turns: [
                        {
                            messageIds: [message.id],
                            runId: "run-reset",
                            startedAt: 5_000,
                        },
                    ],
                },
            }),
        );

        expect(store.session().activeTurn).toEqual({
            runId: "run-reset",
            startedAt: 5_000,
        });
        const finished = event("run_finished", {
            modelLocked: false,
            runId: "run-reset",
            stopReason: "stop",
        });
        store.apply(finished);
        expect(store.session().activeTurn).toBeUndefined();
    });
});

describe("durable status", () => {
    it("takes the status from the opening frame", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello({ session: { ...hello().session!, status: "suspended" } }));

        // A session that is suspended has to read as suspended before anything
        // happens on the stream.
        expect(store.session().status).toBe("suspended");
    });

    it("follows the status without asking for the session again", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());

        const deltas = store.apply(event("session_status_changed", { status: "error" }));

        expect(store.session().status).toBe("error");
        expect(deltas).toContainEqual(expect.objectContaining({ type: "session_changed" }));
    });

    it("keeps the status apart from the activity", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(event("session_status_changed", { status: "running" }));

        store.apply(
            event("session_activity_changed", {
                activity: { kind: "idle", label: "Idle", since: 5 },
            }),
        );

        // Activity is the current moment and settles on its own. The durable
        // status is a lifecycle fact and must not be overwritten by it.
        expect(store.session().activity.kind).toBe("idle");
        expect(store.session().status).toBe("running");
    });

    it("reports a live fact that only lives on the session", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());

        const git = store.apply(event("session_git_changed", { git: { branch: "main" } }));
        const context = store.apply(
            event("session_context_changed", { sessionTokenCount: { total: 5 } }),
        );

        // These change nothing in the element list, so nothing else would tell a
        // subscriber they happened. A store that updated itself silently would
        // leave a branch name or a context meter stale on screen forever.
        expect(git.map((delta) => delta.type)).toEqual(["session_changed"]);
        expect(context.map((delta) => delta.type)).toEqual(["session_changed"]);
    });

    it("advances the authoritative cursor even when a visible value repeats", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(event("session_status_changed", { status: "running" }));

        const repeated = store.apply(event("session_status_changed", { status: "running" }));

        expect(repeated).toHaveLength(1);
        expect(repeated[0]).toMatchObject({
            session: { lastEventId: expect.any(String), status: "running" },
            type: "session_changed",
        });
    });

    it("follows archiving, which is its own flag", () => {
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        expect(store.session().archived).toBe(false);

        store.apply(event("session_archived", { archived: true }));

        expect(store.session().archived).toBe(true);
    });
});

describe("recovering a connection", () => {
    function message(id: string, role: "user" | "agent") {
        return { blocks: [{ text: id, type: "text" }], id, role } as never;
    }

    /** A window of whole turns, named `run-{first}` .. `run-{last}`. */
    function windowOf(first: number, last: number, complete: boolean) {
        const messages: Message[] = [];
        const turns = [];
        for (let index = first; index <= last; index += 1) {
            messages.push(message(`u${index}`, "user"), message(`a${index}`, "agent"));
            turns.push({
                endedAt: index * 100 + 50,
                messageIds: [`u${index}`, `a${index}`],
                outcome: "success" as const,
                runId: `run-${index}`,
                startedAt: index * 100,
            });
        }
        return { complete, messages, turns };
    }

    function helloWith(first: number, last: number, complete: boolean): SessionStreamHello {
        const base = hello();
        const transcript = windowOf(first, last, complete);
        return {
            ...base,
            session: { ...base.session!, snapshot: { messages: transcript.messages } },
            transcript,
        };
    }

    it("keeps the turns it already loaded when a recovery brings a newer window", () => {
        const store = new ChatStore("session-1");
        // A reader has scrolled back and loaded turns 1 through 6.
        store.applyHello(helloWith(1, 6, false));
        const before = store.elements();
        expect(before.length).toBeGreaterThan(0);

        // The cursor expired, so the stream reconnects from scratch and the
        // daemon answers with only the newest turns it bounds a hello to.
        store.applyHello(helloWith(4, 6, false));

        // Losing turns 1 through 3 here would delete rows off the top of a
        // conversation somebody is reading.
        const turnIds = store.elements().map((element) => element.runId);
        expect(turnIds).toContain("run-1");
        expect(turnIds).toContain("run-6");
    });

    it("does not duplicate the turns that both windows describe", () => {
        const store = new ChatStore("session-1");
        store.applyHello(helloWith(1, 6, false));

        store.applyHello(helloWith(4, 6, false));

        const ids = store.elements().map((element) => element.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it("keeps element identities across a recovery, so a reader holds their place", () => {
        const store = new ChatStore("session-1");
        store.applyHello(helloWith(1, 6, false));
        const before = store.elements().map((element) => element.id);

        store.applyHello(helloWith(4, 6, false));

        expect(store.elements().map((element) => element.id)).toEqual(before);
    });

    it("keeps the element a reader is positioned on, by reference", () => {
        const store = new ChatStore("session-1");
        store.applyHello(helloWith(1, 6, false));
        // A reader has scrolled up into the oldest page and is sitting on it.
        const anchor = store.elements().find((element) => element.id === "message:u2");
        expect(anchor).toBeDefined();

        store.applyHello(helloWith(4, 6, false));

        // A retained turn is not restated by the fresh window, so rebuilding its
        // rows into new objects would move a reader off their scroll anchor even
        // though the content is identical.
        expect(store.elements().find((element) => element.id === "message:u2")).toBe(anchor);
    });

    it("keeps real turns through a rewind", () => {
        const store = new ChatStore("session-1");
        store.applyHello(helloWith(1, 6, false));

        // The daemon rewound its active context to turn 4. The already-visible
        // turns after that boundary remain immutable history.
        const remaining = windowOf(1, 4, true);
        store.apply(
            event("session_rewound", {
                messageId: "u5",
                snapshot: { messages: remaining.messages },
                transcript: remaining,
            }),
        );

        const turnIds = store.elements().map((element) => element.runId);
        // Falling back to invented per-message turns here would lose the turn
        // guarantee: a rewound transcript would have no closing element and no
        // real run identity.
        expect(new Set(turnIds)).toEqual(
            new Set(["run-1", "run-2", "run-3", "run-4", "run-5", "run-6"]),
        );
        expect(store.elements().filter((element) => element.kind === "group_end")).toHaveLength(6);
    });

    it("keeps real turns through a reset", () => {
        const store = new ChatStore("session-1");
        store.applyHello(helloWith(1, 6, false));

        store.apply(
            event("session_reset", {
                snapshot: { messages: [] },
                transcript: { complete: true, messages: [], turns: [] },
            }),
        );

        expect(new Set(store.elements().map((element) => element.runId))).toEqual(
            new Set(["run-1", "run-2", "run-3", "run-4", "run-5", "run-6"]),
        );
    });

    it("adds earlier turns in front without disturbing the ones already loaded", () => {
        const store = new ChatStore("session-1");
        store.applyHello(helloWith(4, 6, false));
        const anchor = store.elements().find((element) => element.id === "message:u4");
        const earlier = windowOf(1, 3, true);

        store.prependEarlier({
            ...earlier,
            messageCreatedAt: { a1: 140, u1: 110 },
        });

        const turnIds = store.elements().map((element) => element.runId);
        expect(turnIds.indexOf("run-1")).toBeLessThan(turnIds.indexOf("run-4"));
        // A reader's scroll anchor is a row they are looking at. Rebuilding it
        // while adding history above would jump the viewport.
        expect(store.elements().find((element) => element.id === "message:u4")).toBe(anchor);
        expect(store.elements().find((element) => element.id === "message:u1")?.createdAt).toBe(
            110,
        );
        expect(store.session().transcriptComplete).toBe(true);
        expect(store.session().loadingMore).toBe(false);
    });

    it("does not erase live output or pending steering when an older page lands", () => {
        const store = new ChatStore("session-1");
        store.applyHello(helloWith(4, 6, false));
        const token = store.session().loadMoreToken;
        if (token === undefined) throw new Error("Expected a load-more token.");
        const started = store.startLoadingMore(token);
        if (started === undefined) throw new Error("Expected loading to start.");

        store.apply(
            agentEvent({
                contentIndex: 0,
                delta: "Arrived while paging",
                messageId: "agent-live-during-page",
                type: "text_delta",
            }),
        );
        store.apply(
            event("message_submitted", {
                delivery: "steer",
                displayText: "Also do this",
                message: {
                    blocks: [{ text: "Also do this", type: "text" }],
                    id: "steer-during-page",
                    role: "user",
                },
                runId: "run-6",
            }),
        );
        store.prependEarlier(windowOf(1, 3, true), started.anchor);

        expect(store.elements().some((element) => element.id === "message:u1")).toBe(true);
        expect(
            store
                .elements()
                .some((element) => element.id === "agent-live-during-page:agent_text:0"),
        ).toBe(true);
        expect(store.elements().at(-1)).toMatchObject({
            delivery: "pending_steering",
            messageId: "steer-during-page",
        });
    });

    it.each(["session_reset", "session_rewound"] as const)(
        "keeps immutable turns and ignores a stale earlier page after %s",
        (type) => {
            const store = new ChatStore("session-1");
            store.applyHello(helloWith(4, 6, false));
            const token = store.session().loadMoreToken;
            if (token === undefined) throw new Error("Expected a load-more token.");
            const started = store.startLoadingMore(token);
            if (started === undefined) throw new Error("Expected loading to start.");

            store.apply(
                event(type, {
                    ...(type === "session_rewound" ? { messageId: "u4" } : {}),
                    snapshot: { messages: [] },
                    transcript: { complete: true, messages: [], turns: [] },
                }),
            );
            store.prependEarlier(windowOf(1, 3, true), started.anchor);

            expect(new Set(store.elements().map((element) => element.runId))).toEqual(
                new Set(["run-4", "run-5", "run-6"]),
            );
            expect(store.session().loadingMore).toBe(false);
            expect(store.session().transcriptComplete).toBe(true);
        },
    );

    it("knows which run to ask from, and stops asking at the beginning", () => {
        const store = new ChatStore("session-1");
        store.applyHello(helloWith(4, 6, false));
        expect(store.earliestRunId()).toBe("run-4");

        store.prependEarlier(windowOf(1, 3, true));

        // The conversation is fully loaded, so there is nothing left to ask for.
        expect(store.earliestRunId()).toBeUndefined();
    });

    it("consumes a message token once and clears a failure on the next try", () => {
        const store = new ChatStore("session-1");
        store.applyHello(helloWith(4, 6, false));
        const token = store.session().loadMoreToken;
        if (token === undefined) throw new Error("Expected a load-more token.");

        const started = store.startLoadingMore(token);
        if (started === undefined) throw new Error("Expected loading to start.");
        expect(store.session().loadingMore).toBe(true);
        // A duplicate call from the same render is consumed synchronously.
        expect(store.startLoadingMore(token)).toBeUndefined();
        store.failLoadingMore(started.anchor, "Could not reach Rig.");
        expect(store.session().loadMoreError).toBe("Could not reach Rig.");
        expect(store.session().loadingMore).toBe(false);

        store.startLoadingMore(token);

        // A retry starts from a clean slate, so a stale message is not shown
        // next to a request that is currently in flight.
        expect(store.session().loadMoreError).toBeUndefined();
    });

    it("clears a stale load when the transcript is rebuilt before its request fails", () => {
        const store = new ChatStore("session-1");
        store.applyHello(helloWith(4, 6, false));
        const token = store.session().loadMoreToken;
        if (token === undefined) throw new Error("Expected a load-more token.");
        const started = store.startLoadingMore(token);
        if (started === undefined) throw new Error("Expected loading to start.");

        store.apply(
            event("session_reset", {
                snapshot: { messages: [] },
                transcript: { complete: true, messages: [], turns: [] },
            }),
        );
        store.failLoadingMore(started.anchor, "Stale request failed.");

        expect(store.session().loadingMore).toBe(false);
    });

    it("clears a stale load immediately when a fresh hello replaces the transcript", () => {
        const store = new ChatStore("session-1");
        store.applyHello(helloWith(4, 6, false));
        const token = store.session().loadMoreToken;
        if (token === undefined) throw new Error("Expected a load-more token.");
        expect(store.startLoadingMore(token)).toBeDefined();

        store.applyHello(helloWith(5, 7, false));

        expect(store.session().loadingMore).toBe(false);
        const replacement = store.session().loadMoreToken;
        if (replacement === undefined) throw new Error("Expected a replacement token.");
        expect(store.startLoadingMore(replacement)).toBeDefined();
    });

    it("does not let a complete context window delete immutable history", () => {
        const store = new ChatStore("session-1");
        store.applyHello(helloWith(1, 6, false));

        // Complete describes the supplied context window, not permission to
        // remove turns already present in the user's timeline.
        store.applyHello(helloWith(5, 6, true));

        const turnIds = new Set(store.elements().map((element) => element.runId));
        expect([...turnIds].sort()).toEqual(["run-1", "run-2", "run-3", "run-4", "run-5", "run-6"]);
    });
});

describe("ChatStore and the two clocks a boundary has", () => {
    it("ends a group at compaction and times it from both starts", () => {
        clock = 0;
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(
            event("message_submitted", {
                delivery: "run",
                displayText: "Ask",
                message: { blocks: [{ text: "Ask", type: "text" }], id: "u1", role: "user" },
                runId: "run-1",
            }),
        );
        store.apply(event("run_started", { runId: "run-1" }));
        store.apply(
            agentEvent({ iteration: 1, messageId: "m1", type: "inference_iteration_start" }),
        );
        store.apply(agentEvent({ contentIndex: 0, messageId: "m1", type: "text_start" }));
        store.apply(
            agentEvent({ content: "Before", contentIndex: 0, messageId: "m1", type: "text_end" }),
        );
        store.apply(
            agentEvent({
                compactionId: "c1",
                estimatedTokensBefore: 100,
                type: "context_compaction_started",
            }),
        );
        store.apply(
            agentEvent({
                compactionId: "c1",
                status: "completed",
                type: "context_compaction_finished",
            }),
        );
        store.apply(
            agentEvent({ iteration: 2, messageId: "m2", type: "inference_iteration_start" }),
        );
        store.apply(agentEvent({ contentIndex: 0, messageId: "m2", type: "text_start" }));
        store.apply(
            agentEvent({ content: "After", contentIndex: 0, messageId: "m2", type: "text_end" }),
        );
        store.apply(event("run_finished", { runId: "run-1", stopReason: "stop" }));

        const elements = store.elements();
        expect(elements.map((element) => element.kind)).toEqual([
            "user_message",
            "agent_text",
            "group_end",
            "compaction",
            "agent_text",
            "group_end",
        ]);

        const footers = elements.filter((element) => element.kind === "group_end");
        expect(footers.map((footer) => footer.reason)).toEqual(["compaction", "completed"]);

        // The compaction heads the block that follows it, exactly as a steering
        // message does, so it carries the next group's identity.
        const compaction = elements.find((element) => element.kind === "compaction");
        expect(compaction?.groupId).toBe(footers[1]?.groupId);

        // The second group starts over, but the turn it belongs to does not: it
        // began when the question was submitted, before inference even started.
        const [first, second] = footers;
        expect(first?.turnStartedAt).toBeLessThan(first?.startedAt ?? 0);
        expect(first?.turnElapsedMs).toBeGreaterThan(first?.elapsedMs ?? 0);
        expect(second?.turnStartedAt).toBe(first?.turnStartedAt);
        expect(second?.turnElapsedMs).toBeGreaterThan(second?.elapsedMs ?? 0);
        expect(second?.turnElapsedMs).toBe((second?.endedAt ?? 0) - (first?.turnStartedAt ?? 0));

        // The boundary itself is measured the same two ways.
        expect(compaction?.turnElapsedMs).toBe(
            (compaction?.createdAt ?? 0) - (first?.turnStartedAt ?? 0),
        );
        expect(compaction?.steeringElapsedMs).toBe(compaction?.turnElapsedMs);
    });
});

describe("ChatStore and the failures inside a group", () => {
    it("keeps every attempt in the group and ends a failed one with its own line", () => {
        clock = 0;
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(
            event("message_submitted", {
                delivery: "run",
                displayText: "Ask",
                message: { blocks: [{ text: "Ask", type: "text" }], id: "u1", role: "user" },
                runId: "run-1",
            }),
        );
        store.apply(event("run_started", { runId: "run-1" }));
        store.apply(
            agentEvent({ iteration: 1, messageId: "m1", type: "inference_iteration_start" }),
        );
        store.apply(
            event("agent_message", {
                message: {
                    attempt: 1,
                    blocks: [{ text: "connection lost", type: "text" }],
                    id: "retry-1",
                    outcome: "retried",
                    role: "error",
                },
                runId: "run-1",
            }),
        );
        store.apply(
            event("agent_message", {
                message: {
                    attempt: 2,
                    blocks: [{ text: "rate limited", type: "text" }],
                    id: "retry-2",
                    outcome: "retried",
                    role: "error",
                },
                runId: "run-1",
            }),
        );
        store.apply(agentEvent({ contentIndex: 0, messageId: "m1", type: "text_start" }));
        store.apply(
            agentEvent({ content: "Trying", contentIndex: 0, messageId: "m1", type: "text_end" }),
        );
        store.apply(
            event("agent_message", {
                message: {
                    blocks: [{ text: "It broke", type: "text" }],
                    id: "failed-1",
                    outcome: "failed",
                    role: "error",
                },
                runId: "run-1",
            }),
        );
        store.apply(
            event("run_finished", {
                errorMessage: "It broke",
                runId: "run-1",
                stopReason: "error",
            }),
        );

        const elements = store.elements();
        // The waiting placeholder the group opens with becomes the answer's
        // text, so it holds its slot ahead of attempts that arrived before it.
        expect(elements.map((element) => element.kind)).toEqual([
            "user_message",
            "agent_text",
            "failure",
            "failure",
            "failure",
            "group_end",
        ]);

        // Every attempt, and the failure that ended the work, belong to the one
        // question the group is about.
        expect(new Set(elements.map((element) => element.groupId)).size).toBe(1);

        const failures = elements.filter((element) => element.kind === "failure");
        expect(failures.map((failure) => [failure.outcome, failure.attempt])).toEqual([
            ["retried", 1],
            ["retried", 2],
            ["failed", undefined],
        ]);
        expect(failures.at(-1)?.reason).toBe("It broke");
        expect(elements.at(-1)).toMatchObject({ outcome: "error", reason: "error" });
    });

    it("gives no failure line to a group that was merely stopped", () => {
        clock = 0;
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(event("run_started", { runId: "run-1" }));
        store.apply(
            agentEvent({ iteration: 1, messageId: "m1", type: "inference_iteration_start" }),
        );
        store.apply(agentEvent({ contentIndex: 0, messageId: "m1", type: "text_start" }));
        store.apply(
            agentEvent({ content: "Working", contentIndex: 0, messageId: "m1", type: "text_end" }),
        );
        store.apply(event("abort_requested", { runId: "run-1" }));

        expect(store.elements().some((element) => element.kind === "failure")).toBe(false);
        expect(store.elements().at(-1)).toMatchObject({ outcome: "stopped", reason: "abort" });
    });
});

/** The durable message a completed compaction leaves in history. */
function compactionMessage(id: string, replaced: number, before: number, after: number) {
    return {
        blocks: [],
        id,
        providerId: "claude",
        replacedMessageIds: Array.from({ length: replaced }, (_unused, index) => `gone-${index}`),
        role: "compaction" as const,
        statistics: {
            after: { exact: false, tokens: after },
            before: { exact: true as const, tokens: before },
        },
    };
}

describe("ChatStore live and rebuilt agree", () => {
    /** An event at an exact moment, so two of them can share a millisecond. */
    function at<TType extends string>(
        createdAt: number,
        type: TType,
        data: unknown,
        id: string,
    ): SessionEvent {
        return { createdAt, data, id, sessionId: "session-1", type } as SessionEvent;
    }

    it("keeps a group's last output inside it when both share the closing millisecond", () => {
        const live = new ChatStore("session-1");
        live.applyHello(hello());
        live.apply(
            at(
                10,
                "message_submitted",
                {
                    delivery: "run",
                    displayText: "Ask",
                    message: { blocks: [{ text: "Ask", type: "text" }], id: "u1", role: "user" },
                    runId: "run-1",
                },
                "e1",
            ),
        );
        live.apply(at(10, "run_started", { runId: "run-1" }, "e2"));
        live.apply(
            at(
                20,
                "agent_event",
                {
                    event: { iteration: 1, messageId: "m1", type: "inference_iteration_start" },
                    runId: "run-1",
                },
                "e3",
            ),
        );
        live.apply(
            at(
                20,
                "agent_message",
                {
                    message: { blocks: [{ text: "A", type: "text" }], id: "m1", role: "agent" },
                    runId: "run-1",
                },
                "e4",
            ),
        );
        // The second tool-loop iteration lands in the very millisecond the run
        // ends, which is ordinary: a final short reply and the stop are one tick.
        live.apply(
            at(
                30,
                "agent_event",
                {
                    event: { iteration: 2, messageId: "m2", type: "inference_iteration_start" },
                    runId: "run-1",
                },
                "e5",
            ),
        );
        live.apply(
            at(
                30,
                "agent_message",
                {
                    message: { blocks: [{ text: "B", type: "text" }], id: "m2", role: "agent" },
                    runId: "run-1",
                },
                "e6",
            ),
        );
        live.apply(at(30, "run_finished", { runId: "run-1", stopReason: "stop" }, "e7"));

        const rebuilt = new ChatStore("session-1");
        rebuilt.applyHello({
            ...hello(),
            transcript: {
                complete: true,
                messageCreatedAt: { m1: 20, m2: 30, u1: 10 },
                messageEventId: { m1: "e4", m2: "e6", u1: "e1" },
                messages: [
                    { blocks: [{ text: "Ask", type: "text" }], id: "u1", role: "user" },
                    { blocks: [{ text: "A", type: "text" }], id: "m1", role: "agent" },
                    { blocks: [{ text: "B", type: "text" }], id: "m2", role: "agent" },
                ],
                turns: [
                    {
                        endedAt: 30,
                        groups: [
                            {
                                endedAt: 30,
                                id: "m1",
                                outcome: "success",
                                reason: "completed",
                                startedAt: 20,
                            },
                        ],
                        messageIds: ["u1", "m1", "m2"],
                        outcome: "success",
                        runId: "run-1",
                        startedAt: 10,
                    },
                ],
            },
        });

        const shape = (store: ChatStore) =>
            store.elements().map((element) => [element.kind, element.groupId]);
        expect(shape(rebuilt)).toEqual(shape(live));
        expect(shape(live)).toEqual([
            ["user_message", "group:m1"],
            ["agent_text", "group:m1"],
            ["agent_text", "group:m1"],
            ["group_end", "group:m1"],
        ]);
    });

    it("rebuilds a compaction into the same row and the same times as live", () => {
        const live = new ChatStore("session-1");
        live.applyHello(hello());
        live.apply(
            at(
                10,
                "message_submitted",
                {
                    delivery: "run",
                    displayText: "Ask",
                    message: { blocks: [{ text: "Ask", type: "text" }], id: "u1", role: "user" },
                    runId: "run-1",
                },
                "e1",
            ),
        );
        live.apply(at(10, "run_started", { runId: "run-1" }, "e2"));
        live.apply(
            at(
                20,
                "agent_event",
                {
                    event: { iteration: 1, messageId: "m1", type: "inference_iteration_start" },
                    runId: "run-1",
                },
                "e3",
            ),
        );
        live.apply(
            at(
                20,
                "agent_message",
                {
                    message: { blocks: [{ text: "A", type: "text" }], id: "m1", role: "agent" },
                    runId: "run-1",
                },
                "e4",
            ),
        );
        live.apply(
            at(
                30,
                "agent_event",
                {
                    event: {
                        compactionId: "c1",
                        estimatedTokensBefore: 100,
                        type: "context_compaction_started",
                    },
                    runId: "run-1",
                },
                "e5",
            ),
        );
        live.apply(
            at(
                31,
                "agent_event",
                {
                    event: {
                        compactedMessageCount: 4,
                        compactionId: "c1",
                        estimatedTokensAfter: 40,
                        type: "context_compacted",
                    },
                    runId: "run-1",
                },
                "e6",
            ),
        );
        live.apply(
            at(
                32,
                "agent_event",
                {
                    event: {
                        compactionId: "c1",
                        status: "completed",
                        type: "context_compaction_finished",
                    },
                    runId: "run-1",
                },
                "e7",
            ),
        );
        live.apply(
            at(
                40,
                "agent_event",
                {
                    event: { iteration: 2, messageId: "m2", type: "inference_iteration_start" },
                    runId: "run-1",
                },
                "e8",
            ),
        );
        live.apply(
            at(
                40,
                "agent_message",
                {
                    message: { blocks: [{ text: "B", type: "text" }], id: "m2", role: "agent" },
                    runId: "run-1",
                },
                "e9",
            ),
        );
        live.apply(at(50, "run_finished", { runId: "run-1", stopReason: "stop" }, "e10"));

        const rebuilt = new ChatStore("session-1");
        rebuilt.applyHello({
            ...hello(),
            transcript: {
                complete: true,
                messageBoundaryGroupId: { c1: "m1" },
                messageCreatedAt: { c1: 30, m1: 20, m2: 40, u1: 10 },
                messageEventId: { m1: "e4", m2: "e9", u1: "e1" },
                messages: [
                    { blocks: [{ text: "Ask", type: "text" }], id: "u1", role: "user" },
                    { blocks: [{ text: "A", type: "text" }], id: "m1", role: "agent" },
                    compactionMessage("c1", 4, 100, 40),
                    { blocks: [{ text: "B", type: "text" }], id: "m2", role: "agent" },
                ],
                turns: [
                    {
                        endedAt: 50,
                        groups: [
                            {
                                endedAt: 30,
                                id: "m1",
                                outcome: "success",
                                reason: "compaction",
                                startedAt: 20,
                            },
                            {
                                endedAt: 50,
                                id: "m2",
                                outcome: "success",
                                reason: "completed",
                                startedAt: 40,
                            },
                        ],
                        messageIds: ["u1", "m1", "c1", "m2"],
                        outcome: "success",
                        runId: "run-1",
                        startedAt: 10,
                    },
                ],
            },
        });

        // The compaction is a row a reader saw. History that reported only the
        // boundary would rebuild a list missing it.
        const shape = (store: ChatStore) =>
            store.elements().map((element) => [element.kind, element.groupId]);
        expect(shape(live)).toEqual([
            ["user_message", "group:m1"],
            ["agent_text", "group:m1"],
            ["group_end", "group:m1"],
            ["compaction", "group:m2"],
            ["agent_text", "group:m2"],
            ["group_end", "group:m2"],
        ]);
        expect(shape(rebuilt)).toEqual(shape(live));

        const compactionOf = (store: ChatStore) =>
            store.elements().find((element) => element.kind === "compaction");
        expect(compactionOf(rebuilt)).toMatchObject({
            estimatedTokensAfter: 40,
            estimatedTokensBefore: 100,
            messagesCompacted: 4,
            status: "completed",
            steeringElapsedMs: compactionOf(live)?.steeringElapsedMs,
            turnElapsedMs: compactionOf(live)?.turnElapsedMs,
        });

        const footers = (store: ChatStore) =>
            store
                .elements()
                .filter((element) => element.kind === "group_end")
                .map((footer) => [footer.reason, footer.elapsedMs, footer.turnElapsedMs]);
        expect(footers(rebuilt)).toEqual(footers(live));
        expect(footers(live)).toEqual([
            ["compaction", 10, 20],
            ["completed", 10, 40],
        ]);
    });

    it("closes a run that failed before it ever reached the model", () => {
        clock = 0;
        const store = new ChatStore("session-1");
        store.applyHello(hello());
        store.apply(
            event("message_submitted", {
                delivery: "run",
                displayText: "Ask",
                message: { blocks: [{ text: "Ask", type: "text" }], id: "u1", role: "user" },
                runId: "run-1",
            }),
        );
        store.apply(event("run_started", { runId: "run-1" }));
        // Startup can fail before any inference begins. The question was still
        // asked, so it still has to be told how it ended.
        store.apply(
            event("run_error", { errorMessage: "Runtime failed to start.", runId: "run-1" }),
        );

        expect(store.elements().map((element) => element.kind)).toEqual([
            "user_message",
            "failure",
            "group_end",
        ]);
        expect(store.elements().at(-2)).toMatchObject({
            outcome: "failed",
            reason: "Runtime failed to start.",
        });
        expect(store.elements().at(-1)).toMatchObject({ outcome: "error", reason: "error" });
    });
});

describe("ChatStore when a boundary shares its millisecond", () => {
    /** An event at an exact moment, so several can share a millisecond. */
    function at<TType extends string>(
        createdAt: number,
        type: TType,
        data: unknown,
        id: string,
    ): SessionEvent {
        return { createdAt, data, id, sessionId: "session-1", type } as SessionEvent;
    }

    it("keeps two steerings in one millisecond heading their own groups", () => {
        const live = new ChatStore("session-1");
        live.applyHello(hello());
        live.apply(
            at(
                10,
                "message_submitted",
                {
                    delivery: "run",
                    displayText: "Ask",
                    message: { blocks: [{ text: "Ask", type: "text" }], id: "u1", role: "user" },
                    runId: "r",
                },
                "e1",
            ),
        );
        live.apply(at(10, "run_started", { runId: "r" }, "e2"));
        live.apply(
            at(
                20,
                "agent_event",
                {
                    event: { iteration: 1, messageId: "m1", type: "inference_iteration_start" },
                    runId: "r",
                },
                "e3",
            ),
        );
        live.apply(
            at(
                20,
                "agent_message",
                {
                    message: { blocks: [{ text: "A", type: "text" }], id: "m1", role: "agent" },
                    runId: "r",
                },
                "e4",
            ),
        );
        for (const [i, sid] of ["s1", "s2"].entries()) {
            live.apply(
                at(
                    30,
                    "message_submitted",
                    {
                        delivery: "steer",
                        displayText: sid,
                        message: { blocks: [{ text: sid, type: "text" }], id: sid, role: "user" },
                        runId: "r",
                    },
                    `es${i}a`,
                ),
            );
            live.apply(at(30, "steering_applied", { messageIds: [sid], runId: "r" }, `es${i}b`));
            const mid = i === 0 ? "m2" : "m3";
            live.apply(
                at(
                    30,
                    "agent_event",
                    {
                        event: {
                            iteration: i + 2,
                            messageId: mid,
                            type: "inference_iteration_start",
                        },
                        runId: "r",
                    },
                    `es${i}c`,
                ),
            );
            live.apply(
                at(
                    30,
                    "agent_message",
                    {
                        message: { blocks: [{ text: mid, type: "text" }], id: mid, role: "agent" },
                        runId: "r",
                    },
                    `es${i}d`,
                ),
            );
        }
        live.apply(at(40, "run_finished", { runId: "r", stopReason: "stop" }, "e9"));

        const rebuilt = new ChatStore("session-1");
        rebuilt.applyHello({
            ...hello(),
            transcript: {
                complete: true,
                messageCreatedAt: { m1: 20, m2: 30, m3: 30, s1: 30, s2: 30, u1: 10 },
                messageEventId: {
                    m1: "e4",
                    m2: "es0d",
                    m3: "es1d",
                    s1: "es0a",
                    s2: "es1a",
                    u1: "e1",
                },
                messageSteeredAt: { s1: 30, s2: 30 },
                messageBoundaryGroupId: { s1: "m1", s2: "m2" },
                messages: [
                    { blocks: [{ text: "Ask", type: "text" }], id: "u1", role: "user" },
                    { blocks: [{ text: "A", type: "text" }], id: "m1", role: "agent" },
                    { blocks: [{ text: "s1", type: "text" }], id: "s1", role: "user" },
                    { blocks: [{ text: "m2", type: "text" }], id: "m2", role: "agent" },
                    { blocks: [{ text: "s2", type: "text" }], id: "s2", role: "user" },
                    { blocks: [{ text: "m3", type: "text" }], id: "m3", role: "agent" },
                ],
                turns: [
                    {
                        endedAt: 40,
                        groups: [
                            {
                                endedAt: 30,
                                id: "m1",
                                outcome: "success",
                                reason: "steering",
                                startedAt: 20,
                            },
                            {
                                endedAt: 30,
                                id: "m2",
                                outcome: "success",
                                reason: "steering",
                                startedAt: 30,
                            },
                            {
                                endedAt: 40,
                                id: "m3",
                                outcome: "success",
                                reason: "completed",
                                startedAt: 30,
                            },
                        ],
                        messageIds: ["u1", "m1", "s1", "m2", "s2", "m3"],
                        outcome: "success",
                        runId: "r",
                        startedAt: 10,
                    },
                ],
            },
        });
        // Which group a steering heads cannot be read from the clock when the
        // boundary and the group it opens fall in the same millisecond.
        const shape = (store: ChatStore) =>
            store.elements().map((element) => [element.kind, element.groupId]);
        expect(shape(rebuilt)).toEqual(shape(live));
        expect(shape(live)).toEqual([
            ["user_message", "group:m1"],
            ["agent_text", "group:m1"],
            ["group_end", "group:m1"],
            ["user_message", "group:m2"],
            ["agent_text", "group:m2"],
            ["group_end", "group:m2"],
            ["user_message", "group:m3"],
            ["agent_text", "group:m3"],
            ["group_end", "group:m3"],
        ]);
    });

    it("rebuilds a compaction, the group it opened, and an attempt inside it", () => {
        const live = new ChatStore("session-1");
        live.applyHello(hello());
        live.apply(
            at(
                10,
                "message_submitted",
                {
                    delivery: "run",
                    displayText: "Ask",
                    message: { blocks: [{ text: "Ask", type: "text" }], id: "u1", role: "user" },
                    runId: "r",
                },
                "e1",
            ),
        );
        live.apply(at(10, "run_started", { runId: "r" }, "e2"));
        live.apply(
            at(
                20,
                "agent_event",
                {
                    event: { iteration: 1, messageId: "m1", type: "inference_iteration_start" },
                    runId: "r",
                },
                "e3",
            ),
        );
        live.apply(
            at(
                20,
                "agent_message",
                {
                    message: { blocks: [{ text: "A", type: "text" }], id: "m1", role: "agent" },
                    runId: "r",
                },
                "e4",
            ),
        );
        live.apply(
            at(
                30,
                "agent_event",
                {
                    event: {
                        compactionId: "c1",
                        estimatedTokensBefore: 100,
                        type: "context_compaction_started",
                    },
                    runId: "r",
                },
                "e5",
            ),
        );
        live.apply(
            at(
                30,
                "agent_event",
                {
                    event: {
                        compactionId: "c1",
                        status: "completed",
                        type: "context_compaction_finished",
                    },
                    runId: "r",
                },
                "e6",
            ),
        );
        live.apply(
            at(
                30,
                "agent_event",
                {
                    event: { iteration: 2, messageId: "m2", type: "inference_iteration_start" },
                    runId: "r",
                },
                "e7",
            ),
        );
        live.apply(
            at(
                30,
                "agent_message",
                {
                    message: {
                        attempt: 1,
                        blocks: [{ text: "lost", type: "text" }],
                        id: "retry-1",
                        outcome: "retried",
                        role: "error",
                    },
                    runId: "r",
                },
                "e8",
            ),
        );
        live.apply(
            at(
                30,
                "agent_message",
                {
                    message: { blocks: [{ text: "B", type: "text" }], id: "m2", role: "agent" },
                    runId: "r",
                },
                "e9",
            ),
        );
        live.apply(at(40, "run_finished", { runId: "r", stopReason: "stop" }, "e10"));

        const rebuilt = new ChatStore("session-1");
        const replayDeltas = rebuilt.applyHello({
            ...hello(),
            transcript: {
                complete: true,
                messageBoundaryGroupId: { c1: "m1" },
                messageGroupId: { "retry-1": "m2" },
                messageCreatedAt: { c1: 30, m1: 20, m2: 30, "retry-1": 30, u1: 10 },
                messageEventId: { m1: "e4", m2: "e9", "retry-1": "e8", u1: "e1" },
                messages: [
                    { blocks: [{ text: "Ask", type: "text" }], id: "u1", role: "user" },
                    { blocks: [{ text: "A", type: "text" }], id: "m1", role: "agent" },
                    compactionMessage("c1", 0, 100, 100),
                    {
                        attempt: 1,
                        blocks: [{ text: "lost", type: "text" }],
                        id: "retry-1",
                        outcome: "retried",
                        role: "error",
                    },
                    { blocks: [{ text: "B", type: "text" }], id: "m2", role: "agent" },
                ],
                turns: [
                    {
                        endedAt: 40,
                        groups: [
                            {
                                endedAt: 30,
                                id: "m1",
                                outcome: "success",
                                reason: "compaction",
                                startedAt: 20,
                            },
                            {
                                endedAt: 40,
                                id: "m2",
                                outcome: "success",
                                reason: "completed",
                                startedAt: 30,
                            },
                        ],
                        messageIds: ["u1", "m1", "c1", "retry-1", "m2"],
                        outcome: "success",
                        runId: "r",
                        startedAt: 10,
                    },
                ],
            },
        });
        expect(replayDeltas).not.toContainEqual(expect.objectContaining({ type: "retry_started" }));
        const shape = (store: ChatStore) =>
            store.elements().map((element) => [element.kind, element.groupId]);
        expect(shape(rebuilt)).toEqual(shape(live));
        expect(shape(live)).toEqual([
            ["user_message", "group:m1"],
            ["agent_text", "group:m1"],
            ["group_end", "group:m1"],
            ["compaction", "group:m2"],
            ["agent_text", "group:m2"],
            ["failure", "group:m2"],
            ["group_end", "group:m2"],
        ]);
    });
});
