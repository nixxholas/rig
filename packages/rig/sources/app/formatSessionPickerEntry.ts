import type { SessionSummary } from "../protocol/index.js";
import { formatCompactTokens } from "./formatCompactTokens.js";
import { formatRelativeTime } from "./formatRelativeTime.js";
import { sanitizeTerminalText } from "./sanitizeTerminalText.js";
import { shortenHomePath } from "./shortenHomePath.js";

const MAX_DETAIL_CHARS = 400;

export interface SessionPickerEntry {
    /** Short badge for sessions that need attention or ended unexpectedly. */
    badge?: string;
    /** Last activity plus context size, shown right-aligned next to the title. */
    meta: string;
    /** The most recent thing that happened, or the directory when titles are missing. */
    detail?: string;
    title: string;
}

export function formatSessionPickerEntry(
    session: SessionSummary,
    options: { now: number; showDirectory: boolean },
): SessionPickerEntry {
    const badge = sessionBadge(session);
    const details = [oneLine(session.recap)];
    if (options.showDirectory) details.unshift(shortenHomePath(session.cwd));
    const detail = details.filter((part) => part !== undefined).join(" · ");
    return {
        ...(badge === undefined ? {} : { badge }),
        meta: [
            formatRelativeTime(session.lastMessageAt ?? session.updatedAt, options.now),
            contextSize(session),
        ]
            .filter((part) => part !== undefined)
            .join(" · "),
        ...(detail.length === 0 ? {} : { detail }),
        title: sessionTitle(session),
    };
}

function sessionTitle(session: SessionSummary): string {
    return oneLine(session.title) ?? "Untitled session";
}

function sessionBadge(session: SessionSummary): string | undefined {
    if (session.unread?.reason === "attention_needed") return "Needs attention";
    if (session.status === "running") return "Running";
    if (session.status === "queued") return "Queued";
    if (session.status === "error") return "Error";
    if (session.status === "suspended") return "Suspended";
    if (session.archived) return "Archived";
    return undefined;
}

function contextSize(session: SessionSummary): string | undefined {
    const tokens = session.sessionTokenCount?.lastContextTokens ?? 0;
    if (tokens <= 0) return undefined;
    return `${formatCompactTokens(tokens)} context`;
}

function oneLine(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    const line = sanitizeTerminalText(value).replace(/\s+/gu, " ").trim();
    if (line.length === 0) return undefined;
    return line.length <= MAX_DETAIL_CHARS ? line : `${line.slice(0, MAX_DETAIL_CHARS - 1)}…`;
}
