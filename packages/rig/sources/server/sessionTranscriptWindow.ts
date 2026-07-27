import type { Message } from "../agent/types.js";
import type { SessionTranscriptTurn, SessionTranscriptWindow } from "../protocol/index.js";

/** When a run began, ended, and how, gathered from the durable event log. */
export interface TranscriptRunFacts {
    startedAt: number;
    endedAt?: number;
    outcome?: "success" | "error" | "stopped";
    errorMessage?: string;
}

export interface TranscriptEntry {
    message: Message;
    runId?: string;
}

/**
 * Builds the transcript window carried by a stream's opening frame.
 *
 * The window is cut on turn boundaries rather than after a fixed number of
 * messages. A turn is how a conversation is read, and half of one is not a
 * shorter answer but a broken one: cutting mid-turn can strip the call a tool
 * result belongs to and leave the result with nothing to attach to.
 *
 * Because turns vary in length the message count varies with them. A window of
 * short replies is small; one long run of tool calls can fill it alone. That is
 * the intended trade: the bound tracks the conversation's own structure.
 */
export function sessionTranscriptWindow(
    entries: readonly TranscriptEntry[],
    runFacts: ReadonlyMap<string, TranscriptRunFacts>,
    turnLimit: number,
): SessionTranscriptWindow {
    const groups: { runId: string; messages: Message[] }[] = [];
    // Messages arrive in order, so a run's messages are contiguous and a change
    // of run id is a turn boundary.
    for (const entry of entries) {
        if (entry.message.internal === true) continue;
        const runId = entry.runId ?? `orphan:${entry.message.id}`;
        const open = groups.at(-1);
        if (open !== undefined && open.runId === runId) open.messages.push(entry.message);
        else groups.push({ messages: [entry.message], runId });
    }

    const kept = turnLimit >= groups.length ? groups : groups.slice(-turnLimit);
    const turns: SessionTranscriptTurn[] = kept.map((group) => {
        const facts = runFacts.get(group.runId);
        return {
            messageIds: group.messages.map((message) => message.id),
            runId: group.runId,
            // Messages carry no time of their own, so a turn whose run predates
            // the retained event log reports 0 rather than inventing one. A
            // client renders that as an unknown duration, not as the epoch.
            startedAt: facts?.startedAt ?? 0,
            ...(facts?.endedAt === undefined ? {} : { endedAt: facts.endedAt }),
            ...(facts?.outcome === undefined ? {} : { outcome: facts.outcome }),
            ...(facts?.errorMessage === undefined ? {} : { errorMessage: facts.errorMessage }),
        };
    });

    return {
        complete: kept.length === groups.length,
        messages: kept.flatMap((group) => group.messages),
        turns,
    };
}
