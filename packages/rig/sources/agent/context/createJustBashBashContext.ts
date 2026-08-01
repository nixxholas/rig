import type { Bash } from "just-bash";

import { errorToMessage } from "../../errorToMessage.js";
import type {
    BashContext,
    BashRunResult,
    BashSessionExit,
    BashSessionSnapshot,
} from "./BashContext.js";
import { capOutput } from "./capOutput.js";
import { MAX_ACTIVE_BASH_SESSIONS, MAX_RETAINED_BASH_SESSIONS } from "./bashSessionLimits.js";

interface JustBashSession {
    command: string;
    completion: Promise<BashRunResult>;
    consumingWaiters: number;
    controller: AbortController;
    cwd: string;
    /** Stopped to make room for a newer command, but still readable. */
    evicted?: true;
    exitObserved: boolean;
    killed: boolean;
    maxOutputBytes?: number;
    result?: BashRunResult;
    sessionId: number;
    stderrOffset: number;
    stdoutOffset: number;
    timedOut: boolean;
    timeout?: ReturnType<typeof setTimeout>;
}

export function createJustBashBashContext(bash: Bash, cwd: string): BashContext {
    const sessions = new Map<number, JustBashSession>();
    let nextSessionId = 1;
    let onActiveSessionCountChange: ((count: number) => void) | undefined;
    let onSessionExit: ((exit: BashSessionExit) => void) | undefined;
    const activeSessionCount = () =>
        [...sessions.values()].filter((session) => session.result === undefined && !session.evicted)
            .length;
    const activeSessions = () =>
        [...sessions.values()]
            .filter((session) => session.result === undefined && !session.evicted)
            .map((session) => ({
                command: session.command,
                cwd: session.cwd,
                sessionId: session.sessionId,
                status: "running" as const,
            }));
    const trimSessions = () => {
        while (sessions.size > MAX_RETAINED_BASH_SESSIONS) {
            const completed = [...sessions.values()].find(
                (session) => session.result !== undefined,
            );
            if (completed === undefined) return;
            sessions.delete(completed.sessionId);
        }
    };
    /**
     * Makes room for one more command. Running out of slots is our problem, not
     * the model's, so the oldest command is evicted to free one.
     *
     * The evicted session stays readable: it is stopped, not forgotten, so a
     * model still holding its task ID learns what became of it.
     */
    const makeRoomForSession = () => {
        // An evicted command frees its slot the moment it is asked to stop, so
        // one that takes its time going away cannot hold up the next one.
        for (;;) {
            const active = [...sessions.values()].filter(
                (session) => session.result === undefined && !session.evicted,
            );
            if (active.length < MAX_ACTIVE_BASH_SESSIONS) return;
            const oldest = active.sort((left, right) => left.sessionId - right.sessionId)[0];
            if (oldest === undefined) return;
            oldest.evicted = true;
            oldest.killed = true;
            oldest.controller.abort();
        }
    };
    const readSession = async (
        sessionId: number,
        readOptions: Parameters<BashContext["readSession"]>[1] = {},
    ): Promise<BashSessionSnapshot | undefined> => {
        const session = sessions.get(sessionId);
        if (session === undefined) return undefined;
        const waitMs = Math.max(0, readOptions.waitMs ?? 0);
        const peeking = readOptions.peek === true;
        if (session.result === undefined && waitMs > 0 && !readOptions.signal?.aborted) {
            if (!peeking) session.consumingWaiters += 1;
            try {
                await new Promise<void>((resolveWait) => {
                    let settled = false;
                    let timer: ReturnType<typeof setTimeout> | undefined;
                    const finish = () => {
                        if (settled) return;
                        settled = true;
                        if (timer !== undefined) clearTimeout(timer);
                        readOptions.signal?.removeEventListener("abort", finish);
                        resolveWait();
                    };
                    timer = setTimeout(finish, waitMs);
                    readOptions.signal?.addEventListener("abort", finish, { once: true });
                    void session.completion.then(finish);
                    if (readOptions.signal?.aborted) finish();
                });
            } finally {
                if (!peeking) session.consumingWaiters -= 1;
            }
        }
        const result = session.result;
        const stdout = result?.stdout ?? "";
        const stderr = result?.stderr ?? "";
        const stdoutDelta = stdout.slice(session.stdoutOffset);
        const stderrDelta = stderr.slice(session.stderrOffset);
        if (!peeking) {
            session.stdoutOffset = stdout.length;
            session.stderrOffset = stderr.length;
            if (result !== undefined) session.exitObserved = true;
        }
        return {
            command: session.command,
            cwd: session.cwd,
            exitCode: result?.exitCode ?? null,
            sessionId,
            status: result === undefined ? "running" : session.killed ? "killed" : "completed",
            stderr,
            stderrDelta,
            stdout,
            stdoutDelta,
            timedOut: session.timedOut,
        };
    };

    return {
        activeSessionCount,
        activeSessions,
        cwd,
        async killAllSessions() {
            const active = [...sessions.values()].filter((session) => session.result === undefined);
            for (const session of active) {
                session.exitObserved = true;
                session.killed = true;
                session.controller.abort();
            }
            await Promise.all(active.map((session) => session.completion));
            return active.length;
        },
        async killSession(sessionId) {
            const session = sessions.get(sessionId);
            if (session === undefined) return undefined;
            session.exitObserved = true;
            session.killed = true;
            session.controller.abort();
            await session.completion;
            return readSession(sessionId);
        },
        readSession,
        async run(runOptions) {
            assertNoSecrets(runOptions.secrets);
            const controller = new AbortController();
            const timeout =
                runOptions.timeoutMs === undefined
                    ? undefined
                    : setTimeout(() => controller.abort(), runOptions.timeoutMs);
            const abort = () => controller.abort();
            runOptions.signal?.addEventListener("abort", abort, { once: true });

            try {
                const result = await bash.exec(runOptions.command, {
                    cwd: runOptions.cwd ?? cwd,
                    signal: controller.signal,
                });
                return {
                    stdout: capOutput(result.stdout, runOptions.maxOutputBytes),
                    stderr: capOutput(result.stderr, runOptions.maxOutputBytes),
                    exitCode: result.exitCode,
                    timedOut: controller.signal.aborted,
                };
            } finally {
                if (timeout !== undefined) clearTimeout(timeout);
                runOptions.signal?.removeEventListener("abort", abort);
            }
        },
        async startSession(runOptions) {
            assertNoSecrets(runOptions.secrets);
            makeRoomForSession();
            const controller = new AbortController();
            const sessionId = nextSessionId;
            nextSessionId += 1;
            const session: JustBashSession = {
                command: runOptions.command,
                completion: Promise.resolve({
                    exitCode: null,
                    stderr: "",
                    stdout: "",
                    timedOut: false,
                }),
                consumingWaiters: 0,
                controller,
                cwd: runOptions.cwd ?? cwd,
                exitObserved: false,
                killed: false,
                ...(runOptions.maxOutputBytes === undefined
                    ? {}
                    : { maxOutputBytes: runOptions.maxOutputBytes }),
                sessionId,
                stderrOffset: 0,
                stdoutOffset: 0,
                timedOut: false,
            };
            session.completion = bash
                .exec(runOptions.command, {
                    cwd: session.cwd,
                    signal: controller.signal,
                })
                .then((result) => ({
                    stdout: capOutput(result.stdout, session.maxOutputBytes),
                    stderr: capOutput(result.stderr, session.maxOutputBytes),
                    exitCode: result.exitCode,
                    timedOut: session.timedOut,
                }))
                .catch((error: unknown) => ({
                    stdout: "",
                    stderr: errorToMessage(error),
                    exitCode: null,
                    timedOut: session.timedOut,
                }));
            sessions.set(sessionId, session);
            onActiveSessionCountChange?.(activeSessionCount());
            if (runOptions.timeoutMs !== undefined) {
                session.timeout = setTimeout(() => {
                    session.timedOut = true;
                    session.killed = true;
                    controller.abort();
                }, runOptions.timeoutMs);
            }
            void session.completion.then((result) => {
                session.result = result;
                if (session.timeout !== undefined) clearTimeout(session.timeout);
                const awaited = session.consumingWaiters > 0;
                onActiveSessionCountChange?.(activeSessionCount());
                trimSessions();
                if (!awaited && !session.exitObserved) {
                    onSessionExit?.({
                        command: session.command,
                        exitCode: result.exitCode,
                        sessionId,
                        status: session.killed || result.exitCode === null ? "killed" : "completed",
                    });
                }
            });
            trimSessions();
            return sessionId;
        },
        setActiveSessionCountListener(listener) {
            onActiveSessionCountChange = listener;
            listener?.(activeSessionCount());
        },
        setSessionExitListener(listener) {
            onSessionExit = listener;
        },
        supportsSessionInput: false,
        async writeSession() {
            return false;
        },
    };
}

function assertNoSecrets(secrets: readonly string[] | undefined): void {
    if (secrets !== undefined && secrets.length > 0) {
        throw new Error("The in-memory Bash backend cannot inject Rig secrets.");
    }
}
