import { describe, expect, it } from "vitest";

import type { AgentLoopEvent } from "../../agent/index.js";
import type { SessionActivity, SessionEvent } from "../../protocol/index.js";
import { IDLE_SESSION_ACTIVITY, sessionActivityAfterEvent } from "../sessionActivityAfterEvent.js";

let clock = 0;

function event<TType extends SessionEvent["type"]>(
    type: TType,
    data: Extract<SessionEvent, { type: TType }>["data"],
): SessionEvent {
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

function apply(events: readonly SessionEvent[]): SessionActivity {
    return events.reduce(sessionActivityAfterEvent, IDLE_SESSION_ACTIVITY);
}

function toolCall(id: string, name: string) {
    return { arguments: {}, id, name, type: "tool_call" } as never;
}

describe("sessionActivityAfterEvent", () => {
    it("reports thinking once a run starts", () => {
        const activity = apply([event("run_started", { runId: "run-1" })]);

        expect(activity.kind).toBe("thinking");
        expect(activity.label).toBe("Thinking");
        expect(activity.runId).toBe("run-1");
    });

    it("distinguishes writing a reply from preparing a tool call", () => {
        const start = event("run_started", { runId: "run-1" });

        expect(
            apply([start, agentEvent({ contentIndex: 0, type: "text_start" } as AgentLoopEvent)])
                .kind,
        ).toBe("generating_message");
        expect(
            apply([
                start,
                agentEvent({ contentIndex: 0, type: "toolcall_start" } as AgentLoopEvent),
            ]).kind,
        ).toBe("generating_tool_call");
    });

    it("names the tool it is running", () => {
        const activity = apply([
            event("run_started", { runId: "run-1" }),
            agentEvent({ toolCall: toolCall("call-1", "Bash"), type: "tool_execution_start" }),
        ]);

        expect(activity.kind).toBe("executing_tool_call");
        expect(activity.label).toBe("Running Bash");
        expect(activity.toolCalls).toEqual([
            { startedAt: expect.any(Number), toolCallId: "call-1", toolName: "Bash" },
        ]);
    });

    it("reports tools while Auto reviews them and clears the review before execution", () => {
        const reviewing = [
            event("run_started", { runId: "run-1" }),
            agentEvent({
                action: "running a host command",
                toolCallId: "call-1",
                toolName: "Bash",
                type: "permission_review_started",
            }),
        ];

        const started = apply(reviewing);
        expect(started.kind).toBe("reviewing_tool_call");
        expect(started.label).toBe("Reviewing Bash");
        expect(started.reviewingToolCalls).toEqual([
            {
                action: "running a host command",
                startedAt: expect.any(Number),
                toolCallId: "call-1",
                toolName: "Bash",
            },
        ]);
        const completed = apply([
            ...reviewing,
            agentEvent({
                action: "running a host command",
                decision: "deny",
                reason: "The action was not authorized.",
                risk: "high",
                toolCallId: "call-1",
                type: "permission_review",
                userAuthorization: "low",
            }),
        ]);
        expect(completed.kind).toBe("thinking");
        expect(completed.reviewingToolCalls).toBeUndefined();

        const recovered = apply([
            ...reviewing,
            agentEvent({
                iteration: 2,
                messageId: "message-2",
                type: "inference_iteration_start",
            }),
        ]);
        expect(recovered.kind).toBe("thinking");
        expect(recovered.reviewingToolCalls).toBeUndefined();
    });

    it("prefers a tool's own reported status over the tool name", () => {
        const activity = apply([
            event("run_started", { runId: "run-1" }),
            agentEvent({ toolCall: toolCall("call-1", "Bash"), type: "tool_execution_start" }),
            agentEvent({
                status: "Running the test suite",
                toolCallId: "call-1",
                type: "tool_execution_status",
            }),
        ]);

        expect(activity.label).toBe("Running the test suite");
    });

    it("counts concurrent tools and returns to thinking when they all finish", () => {
        const running = [
            event("run_started", { runId: "run-1" }),
            agentEvent({ toolCall: toolCall("call-1", "Bash"), type: "tool_execution_start" }),
            agentEvent({ toolCall: toolCall("call-2", "Read"), type: "tool_execution_start" }),
        ];

        expect(apply(running).label).toBe("Running 2 tools");

        const finished = apply([
            ...running,
            agentEvent({
                result: { toolCallId: "call-1", toolName: "Bash", type: "tool_result" } as never,
                type: "tool_execution_end",
            }),
            agentEvent({
                result: { toolCallId: "call-2", toolName: "Read", type: "tool_result" } as never,
                type: "tool_execution_end",
            }),
        ]);

        expect(finished.kind).toBe("thinking");
        expect(finished.toolCalls).toBeUndefined();
    });

    it("keeps reporting a running tool while the model streams its next block", () => {
        const activity = apply([
            event("run_started", { runId: "run-1" }),
            agentEvent({ toolCall: toolCall("call-1", "Bash"), type: "tool_execution_start" }),
            agentEvent({ contentIndex: 0, type: "text_start" } as AgentLoopEvent),
        ]);

        expect(activity.kind).toBe("executing_tool_call");
    });

    it("reports compaction until it finishes", () => {
        const compacting = [
            event("run_started", { runId: "run-1" }),
            agentEvent({
                compactionId: "compaction-1",
                estimatedTokensBefore: 120_000,
                reason: "threshold",
                type: "context_compaction_started",
            }),
        ];

        const started = apply(compacting);
        expect(started.kind).toBe("compacting");
        expect(started.compaction?.compactionId).toBe("compaction-1");

        const finished = apply([
            ...compacting,
            agentEvent({
                compactionId: "compaction-1",
                elapsedMs: 10,
                status: "completed",
                type: "context_compaction_finished",
            }),
        ]);
        expect(finished.kind).toBe("thinking");
        expect(finished.compaction).toBeUndefined();
    });

    it("reports a retry and clears it when the next iteration starts", () => {
        const retrying = [
            event("run_started", { runId: "run-1" }),
            agentEvent({
                attempt: 2,
                messageId: "message-1",
                reason: "rate limited",
                type: "retrying",
            }),
        ];

        const activity = apply(retrying);
        expect(activity.kind).toBe("retrying");
        expect(activity.label).toBe("Retrying: rate limited");
        expect(activity.retry).toEqual({ attempt: 2, reason: "rate limited" });

        const recovered = apply([
            ...retrying,
            agentEvent({ iteration: 2, messageId: "message-2", type: "inference_iteration_start" }),
        ]);
        expect(recovered.kind).toBe("thinking");
        expect(recovered.retry).toBeUndefined();
    });

    it("reports waiting for an answer while an input request is open", () => {
        const asked = [
            event("run_started", { runId: "run-1" }),
            agentEvent({ toolCall: toolCall("call-1", "Bash"), type: "tool_execution_start" }),
            event("user_input_requested", { questions: [], requestId: "call-1:permission" }),
        ];

        const waiting = apply(asked);
        expect(waiting.kind).toBe("awaiting_input");
        expect(waiting.pendingInputRequestIds).toEqual(["call-1:permission"]);

        const answered = apply([
            ...asked,
            event("user_input_resolved", { requestId: "call-1:permission", status: "answered" }),
        ]);
        expect(answered.kind).toBe("executing_tool_call");
        expect(answered.pendingInputRequestIds).toBeUndefined();
    });

    it("stops reporting a question once presence detaches it", () => {
        const activity = apply([
            event("run_started", { runId: "run-1" }),
            event("user_input_requested", { questions: [], requestId: "question-1" }),
            event("user_input_detached", {
                presenceId: "away",
                reason: "away",
                requestId: "question-1",
            }),
        ]);

        expect(activity.kind).toBe("thinking");
        expect(activity.pendingInputRequestIds).toBeUndefined();
    });

    it("reports how a run ended", () => {
        const started = event("run_started", { runId: "run-1" });

        expect(
            apply([
                started,
                event("run_finished", { modelLocked: false, runId: "run-1", stopReason: "stop" }),
            ]).kind,
        ).toBe("idle");
        expect(
            apply([
                started,
                event("run_finished", {
                    modelLocked: false,
                    runId: "run-1",
                    stopReason: "aborted",
                }),
            ]).kind,
        ).toBe("stopped");
        expect(
            apply([
                started,
                event("run_error", {
                    errorMessage: "The provider failed.",
                    modelLocked: false,
                    runId: "run-1",
                }),
            ]).kind,
        ).toBe("error");
    });

    it("stays active across the technical abort used to continue steering", () => {
        const before = apply([event("run_started", { runId: "run-1" })]);
        const after = sessionActivityAfterEvent(
            before,
            event("abort_requested", {
                continuePendingSteering: true,
                runId: "run-1",
            }),
        );

        expect(after).toBe(before);
    });

    it("returns the same activity when an event says nothing about current work", () => {
        const before = apply([event("run_started", { runId: "run-1" })]);
        const after = sessionActivityAfterEvent(
            before,
            event("session_title_changed", { status: "ready", title: "A title" }),
        );

        expect(after).toBe(before);
    });
});
