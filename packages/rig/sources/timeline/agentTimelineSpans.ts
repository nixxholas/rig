import type { SessionEvent, TimelineSpan, TimelineSpanOutcome } from "../protocol/index.js";
import type { TimelineAgentSource } from "./TimelineSource.js";

/**
 * Folds one agent's lifecycle events into the bars of its row.
 *
 * Nothing is inferred beyond what Rig durably recorded. A run that never
 * reported an ending, on a session that is no longer working, is reported as
 * interrupted rather than quietly completed, and a session still working keeps
 * an open span instead of being given an invented end.
 */
export function agentTimelineSpans(
    agent: TimelineAgentSource,
    events: readonly SessionEvent[],
): readonly TimelineSpan[] {
    const spans: TimelineSpan[] = [];
    const asking = new Map<string, TimelineSpan>();
    let working: TimelineSpan | undefined;
    let waiting: TimelineSpan | undefined = openSpan("waiting", agent.createdAt);
    spans.push(waiting);
    let lastEventAt = agent.createdAt;
    for (const event of events) {
        lastEventAt = event.createdAt;
        if (event.type === "message_submitted") {
            if (waiting !== undefined) close(waiting, event.createdAt, "completed");
            waiting = undefined;
            continue;
        }
        if (event.type === "run_started") {
            // A run starting while another is still open means the earlier one
            // never reported its ending.
            if (working !== undefined) close(working, event.createdAt, "interrupted");
            if (waiting !== undefined) close(waiting, event.createdAt, "completed");
            waiting = undefined;
            working = openSpan("working", event.createdAt, event.data.runId);
            spans.push(working);
            continue;
        }
        if (event.type === "run_finished" || event.type === "run_error") {
            if (working === undefined) {
                // The run began before the retained history did, so where it
                // ended is the only honest thing left to record.
                working = openSpan("working", event.createdAt, event.data.runId);
                spans.push(working);
            }
            close(working, event.createdAt, terminalOutcome(event));
            working = undefined;
            waiting = openSpan("waiting", event.createdAt);
            spans.push(waiting);
            continue;
        }
        if (event.type === "user_input_requested") {
            const span: TimelineSpan = {
                kind: "asking",
                requestId: event.data.requestId,
                startedAt: event.createdAt,
            };
            asking.set(event.data.requestId, span);
            spans.push(span);
            continue;
        }
        if (event.type === "user_input_resolved" || event.type === "user_input_detached") {
            const span = asking.get(event.data.requestId);
            if (span === undefined) continue;
            const answered =
                event.type === "user_input_resolved" && event.data.status === "answered";
            close(span, event.createdAt, answered ? "answered" : "cancelled");
            asking.delete(event.data.requestId);
        }
    }
    if (!agent.working) {
        // The session is not working, so whatever is still open never ended:
        // the daemon stopped, or the run died without reporting.
        if (working !== undefined) close(working, lastEventAt, "interrupted");
        for (const span of asking.values()) close(span, lastEventAt, "cancelled");
    }
    // A trailing waiting span stays open on purpose. The chat really is still
    // waiting for the person, and the chart draws that as a bar running to now.
    //
    // Waiting is the one kind Rig infers rather than records, so a stretch of it
    // that took no time at all — a subagent handed its prompt the instant it was
    // created — is dropped instead of becoming a bar nobody waited through. A
    // run or a question is a recorded fact and stays, however brief.
    return spans.filter(
        (span) =>
            span.kind !== "waiting" || span.endedAt === undefined || span.endedAt > span.startedAt,
    );
}

function terminalOutcome(event: SessionEvent): TimelineSpanOutcome {
    if (event.type === "run_error") return "error";
    if (event.type !== "run_finished") return "completed";
    if (event.data.stopReason === "aborted") return "aborted";
    if (event.data.stopReason === "error") return "error";
    return "completed";
}

function openSpan(kind: TimelineSpan["kind"], startedAt: number, runId?: string): TimelineSpan {
    return { kind, startedAt, ...(runId === undefined ? {} : { runId }) };
}

function close(span: TimelineSpan, endedAt: number, outcome: TimelineSpanOutcome): void {
    span.endedAt = Math.max(endedAt, span.startedAt);
    span.outcome = outcome;
}
