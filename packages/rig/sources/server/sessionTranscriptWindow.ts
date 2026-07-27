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
    createdAt?: number;
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
    /**
     * Return the turns that come immediately before this run, rather than the
     * newest ones. This is how a reader pages back through a long conversation.
     */
    before?: string,
): SessionTranscriptWindow | undefined {
    const groups: { runId: string; entries: TranscriptEntry[] }[] = [];
    // Messages arrive in order, so a run's messages are contiguous and a change
    // of run id is a turn boundary.
    for (const entry of entries) {
        if (entry.message.internal === true) continue;
        const runId = entry.runId ?? `orphan:${entry.message.id}`;
        const open = groups.at(-1);
        if (open !== undefined && open.runId === runId) open.entries.push(entry);
        else groups.push({ entries: [entry], runId });
    }

    // Everything from the requested run onwards is already held by whoever asked
    // for it, so paging looks at the conversation that precedes it.
    let earlier = groups;
    if (before !== undefined) {
        const index = indexOfRun(groups, before);
        // A run the transcript no longer has cannot anchor a page. Answering
        // with the newest turns instead would look like a successful page and
        // silently duplicate the conversation.
        if (index === undefined) return undefined;
        earlier = groups.slice(0, index);
    }
    const kept = turnLimit >= earlier.length ? earlier : earlier.slice(-turnLimit);
    const turns: SessionTranscriptTurn[] = kept.map((group) => {
        const facts = runFacts.get(group.runId);
        return {
            messageIds: group.entries.map((entry) => entry.message.id),
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

    const messageCreatedAt = Object.fromEntries(
        kept.flatMap((group) =>
            group.entries.flatMap((entry) =>
                entry.createdAt === undefined ? [] : [[entry.message.id, entry.createdAt]],
            ),
        ),
    );
    return {
        complete: kept.length === earlier.length,
        ...(Object.keys(messageCreatedAt).length === 0 ? {} : { messageCreatedAt }),
        messages: kept.flatMap((group) => group.entries.map((entry) => entry.message)),
        turns,
    };
}

/** Where a run sits among the turns, or undefined when it is not among them. */
function indexOfRun(groups: readonly { runId: string }[], runId: string): number | undefined {
    const index = groups.findIndex((group) => group.runId === runId);
    return index === -1 ? undefined : index;
}
