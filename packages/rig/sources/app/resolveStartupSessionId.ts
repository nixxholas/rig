import type { ProtocolHttpClient } from "../client/index.js";
import type { SessionSummary } from "../protocol/index.js";
import { RigUserError } from "../RigUserError.js";
import type { SessionCommandOptions } from "./parseSessionCommand.js";
import { shortenHomePath } from "./shortenHomePath.js";
import type { StartupStatusApp } from "./StartupStatusApp.js";

export interface StartupSessionSelection {
    command: "fork" | "resume";
    selection: SessionCommandOptions;
}

/** Enough history to find the session you meant, few enough to scroll through. */
const MAX_OFFERED_SESSIONS = 50;

/**
 * Turns a `rig resume` or `rig fork` invocation into the session the TUI should open, asking the
 * user on the startup screen when the command did not name one. Returns undefined when the user
 * dismisses the picker, which is a decision rather than a failure.
 */
export async function resolveStartupSessionId(options: {
    client: ProtocolHttpClient;
    cwd: string;
    selection: StartupSessionSelection;
    startup: StartupStatusApp;
}): Promise<string | undefined> {
    const forking = options.selection.command === "fork";
    const { all, last, sessionId: requestedSessionId } = options.selection.selection;
    let sessionId = requestedSessionId;
    if (sessionId === undefined) {
        options.startup.setStatus("Loading saved sessions.");
        // Asking to resume is asking for saved sessions, so sessions the TUI archived on
        // its way out belong in the list just as much as the ones still showing.
        const listed = await options.client.listSessions({ archived: "all" });
        const matching = all
            ? listed.sessions
            : listed.sessions.filter((session) => session.cwd === options.cwd);
        // Resuming is about recent work, so recency wins over the board ordering the
        // dashboard uses, and only the newest handful is worth paging through.
        const sessions = [...matching]
            .sort((left, right) => lastActivity(right) - lastActivity(left))
            .slice(0, MAX_OFFERED_SESSIONS);
        if (sessions.length === 0) {
            throw all
                ? new RigUserError("Rig has no saved sessions yet.", {
                      hint: "Run rig to start one.",
                  })
                : new RigUserError(
                      `Rig has no saved sessions in ${shortenHomePath(options.cwd)}.`,
                      { hint: "Use --all to pick a session from another directory." },
                  );
        }
        if (last) {
            sessionId = sessions[0]?.id;
            if (sessionId === undefined) {
                throw new RigUserError("Rig has no saved sessions yet.", {
                    hint: "Run rig to start one.",
                });
            }
        } else {
            sessionId = await options.startup.selectSession({
                confirmVerb: forking ? "fork" : "resume",
                sessions,
                showDirectory: all,
                subtitle: all
                    ? `${countLabel(sessions.length, matching.length)} across every directory.`
                    : `${countLabel(sessions.length, matching.length)} in ${shortenHomePath(
                          options.cwd,
                      )}.`,
                title: forking ? "Fork a session" : "Resume a session",
            });
            if (sessionId === undefined) return undefined;
        }
    }

    if (!forking) return sessionId;
    options.startup.setStatus("Forking session.");
    const forked = await options.client.forkSession(sessionId);
    return forked.session.id;
}

function lastActivity(session: SessionSummary): number {
    return session.lastMessageAt ?? session.updatedAt;
}

/** Says so plainly when older sessions exist beyond the ones being offered. */
function countLabel(shown: number, available: number): string {
    if (shown < available) return `${shown} most recent of ${available} saved sessions`;
    return `${shown} saved session${shown === 1 ? "" : "s"}`;
}
