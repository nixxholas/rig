import { describe, expect, it } from "vitest";

import type { SessionEvent } from "../../protocol/index.js";
import { agentTimelineSpans } from "../agentTimelineSpans.js";
import type { TimelineAgentSource } from "../TimelineSource.js";

const MINUTE = 60_000;

describe("agentTimelineSpans", () => {
    it("charts a chat as waiting, then working, then waiting again", () => {
        const spans = agentTimelineSpans(agent(), [
            messageSubmitted(2 * MINUTE, "run-1"),
            runStarted(2 * MINUTE, "run-1"),
            runFinished(5 * MINUTE, "run-1", "stop"),
        ]);

        expect(spans).toEqual([
            { endedAt: 2 * MINUTE, kind: "waiting", outcome: "completed", startedAt: 0 },
            {
                endedAt: 5 * MINUTE,
                kind: "working",
                outcome: "completed",
                runId: "run-1",
                startedAt: 2 * MINUTE,
            },
            { kind: "waiting", startedAt: 5 * MINUTE },
        ]);
    });

    it("leaves the working span open while the session is still working", () => {
        const spans = agentTimelineSpans({ ...agent(), working: true }, [
            messageSubmitted(MINUTE, "run-1"),
            runStarted(MINUTE, "run-1"),
        ]);

        expect(spans).toEqual([
            { endedAt: MINUTE, kind: "waiting", outcome: "completed", startedAt: 0 },
            { kind: "working", runId: "run-1", startedAt: MINUTE },
        ]);
    });

    it("reports a run that never ended on a stopped session as interrupted", () => {
        // The daemon died mid-run, so no terminal event was ever written. Saying
        // the work completed would be a guess; saying it was interrupted is what
        // history actually shows.
        const spans = agentTimelineSpans(agent(), [
            messageSubmitted(MINUTE, "run-1"),
            runStarted(MINUTE, "run-1"),
        ]);

        expect(spans).toEqual([
            { endedAt: MINUTE, kind: "waiting", outcome: "completed", startedAt: 0 },
            {
                endedAt: MINUTE,
                kind: "working",
                outcome: "interrupted",
                runId: "run-1",
                startedAt: MINUTE,
            },
        ]);
    });

    it("distinguishes an abort from a failure and from a normal stop", () => {
        const spans = agentTimelineSpans(agent(), [
            runStarted(MINUTE, "run-1"),
            runFinished(2 * MINUTE, "run-1", "aborted"),
            runStarted(3 * MINUTE, "run-2"),
            runError(4 * MINUTE, "run-2"),
            runStarted(5 * MINUTE, "run-3"),
            runFinished(6 * MINUTE, "run-3", "stop"),
        ]);

        expect(spans.filter((span) => span.kind === "working").map((span) => span.outcome)).toEqual(
            ["aborted", "error", "completed"],
        );
    });

    it("charts an open question alongside the run that asked it", () => {
        const spans = agentTimelineSpans(agent(), [
            runStarted(MINUTE, "run-1"),
            userInputRequested(2 * MINUTE, "ask-1"),
            userInputResolved(4 * MINUTE, "ask-1", "answered"),
            runFinished(5 * MINUTE, "run-1", "stop"),
        ]);

        expect(spans.find((span) => span.kind === "asking")).toEqual({
            endedAt: 4 * MINUTE,
            kind: "asking",
            outcome: "answered",
            requestId: "ask-1",
            startedAt: 2 * MINUTE,
        });
    });

    it("closes an unanswered question when the session is no longer working", () => {
        const spans = agentTimelineSpans(agent(), [
            runStarted(MINUTE, "run-1"),
            userInputRequested(2 * MINUTE, "ask-1"),
            runFinished(3 * MINUTE, "run-1", "aborted"),
        ]);

        expect(spans.find((span) => span.kind === "asking")).toEqual({
            endedAt: 3 * MINUTE,
            kind: "asking",
            outcome: "cancelled",
            requestId: "ask-1",
            startedAt: 2 * MINUTE,
        });
    });

    it("closes a run that a later run implicitly replaced", () => {
        const spans = agentTimelineSpans(agent(), [
            runStarted(MINUTE, "run-1"),
            runStarted(2 * MINUTE, "run-2"),
            runFinished(3 * MINUTE, "run-2", "stop"),
        ]);

        expect(spans.filter((span) => span.kind === "working")).toEqual([
            {
                endedAt: 2 * MINUTE,
                kind: "working",
                outcome: "interrupted",
                runId: "run-1",
                startedAt: MINUTE,
            },
            {
                endedAt: 3 * MINUTE,
                kind: "working",
                outcome: "completed",
                runId: "run-2",
                startedAt: 2 * MINUTE,
            },
        ]);
    });

    it("records where a run ended when its start fell outside retained history", () => {
        const spans = agentTimelineSpans(agent(), [runFinished(3 * MINUTE, "run-1", "stop")]);

        expect(spans.filter((span) => span.kind === "working")).toEqual([
            {
                endedAt: 3 * MINUTE,
                kind: "working",
                outcome: "completed",
                runId: "run-1",
                startedAt: 3 * MINUTE,
            },
        ]);
    });

    it("drops a waiting span the person never actually spent waiting", () => {
        // A subagent is handed its prompt the moment it is created, so the gap
        // before its first run is zero and must not become a visible bar.
        const spans = agentTimelineSpans({ ...agent(), type: "subagent" }, [
            messageSubmitted(0, "run-1"),
            runStarted(0, "run-1"),
            runFinished(MINUTE, "run-1", "stop"),
        ]);

        expect(spans[0]).toEqual({
            endedAt: MINUTE,
            kind: "working",
            outcome: "completed",
            runId: "run-1",
            startedAt: 0,
        });
    });

    it("keeps a primary chat's initial waiting state when submission shares its timestamp", () => {
        const spans = agentTimelineSpans(agent(), [
            messageSubmitted(0, "run-1"),
            runStarted(0, "run-1"),
            runFinished(MINUTE, "run-1", "stop"),
        ]);

        expect(spans.map((span) => span.kind)).toEqual(["waiting", "working", "waiting"]);
        expect(spans[0]).toEqual({
            endedAt: 0,
            kind: "waiting",
            outcome: "completed",
            startedAt: 0,
        });
    });
});

function agent(): TimelineAgentSource {
    return {
        agentId: "agent-1",
        archived: false,
        createdAt: 0,
        depth: 0,
        modelId: "model",
        projectId: "project-1",
        providerId: "codex",
        sessionId: "session-1",
        type: "primary",
        working: false,
    };
}

function event(type: string, createdAt: number, data: unknown): SessionEvent {
    return {
        createdAt,
        data,
        id: `${type}-${String(createdAt)}`,
        sessionId: "session-1",
        type,
    } as SessionEvent;
}

function messageSubmitted(createdAt: number, runId: string): SessionEvent {
    return event("message_submitted", createdAt, {
        displayText: "Do it",
        message: { blocks: [], id: "m", role: "user" },
        runId,
    });
}

function runStarted(createdAt: number, runId: string): SessionEvent {
    return event("run_started", createdAt, { runId });
}

function runFinished(createdAt: number, runId: string, stopReason: string): SessionEvent {
    return event("run_finished", createdAt, { modelLocked: false, runId, stopReason });
}

function runError(createdAt: number, runId: string): SessionEvent {
    return event("run_error", createdAt, {
        errorMessage: "boom",
        modelLocked: false,
        runId,
    });
}

function userInputRequested(createdAt: number, requestId: string): SessionEvent {
    return event("user_input_requested", createdAt, { questions: [], requestId });
}

function userInputResolved(createdAt: number, requestId: string, status: string): SessionEvent {
    return event("user_input_resolved", createdAt, { requestId, status });
}
