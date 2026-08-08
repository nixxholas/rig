export interface BashRunOptions {
    command: string;
    cwd?: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
    secrets?: readonly string[];
    shell?: string;
    signal?: AbortSignal;
    /** Run the command under a pseudo-terminal instead of pipes. */
    tty?: boolean;
}

export interface BashRunResult {
    stdout: string;
    stderr: string;
    stdoutBytes?: number;
    stderrBytes?: number;
    stdoutOmittedBytes?: number;
    stderrOmittedBytes?: number;
    exitCode: number | null;
    timedOut: boolean;
}

export type BashSessionStatus = "completed" | "killed" | "running";

export interface BashSessionSnapshot {
    command: string;
    cwd: string;
    exitCode: number | null;
    sessionId: number;
    status: BashSessionStatus;
    stderr: string;
    stderrDelta: string;
    stderrDeltaBytes?: number;
    stderrDeltaOmittedBytes?: number;
    stderrBytes?: number;
    stderrOmittedBytes?: number;
    stdout: string;
    stdoutDelta: string;
    stdoutDeltaBytes?: number;
    stdoutDeltaOmittedBytes?: number;
    stdoutBytes?: number;
    stdoutOmittedBytes?: number;
    timedOut: boolean;
}

export interface BashSessionReadOptions {
    /**
     * Look without consuming. The delta cursor belongs to the agent, so
     * observers such as the terminal viewer must not advance it.
     */
    peek?: boolean;
    signal?: AbortSignal;
    waitMs?: number;
}

export interface BashSessionExit {
    command: string;
    exitCode: number | null;
    sessionId: number;
    status: "completed" | "killed";
}

export interface BashSessionActivity {
    command: string;
    cwd: string;
    sessionId: number;
    status: "running";
}

export interface BashContext {
    activeSessionCount?(): number;
    activeSessions?(): readonly BashSessionActivity[];
    cwd: string;
    /**
     * Marks a session as work the agent means to leave running, so that
     * interrupting the turn no longer stops it.
     */
    detachSession?(sessionId: number): void;
    interruptSession?(sessionId: number): Promise<boolean | undefined>;
    killAllSessions?(): Promise<number>;
    killSession(sessionId: number): Promise<BashSessionSnapshot | undefined>;
    readSession(
        sessionId: number,
        options?: BashSessionReadOptions,
    ): Promise<BashSessionSnapshot | undefined>;
    run(options: BashRunOptions): Promise<BashRunResult>;
    sessionUsesSecrets?(sessionId: number): boolean;
    setActiveSessionCountListener?(listener: ((count: number) => void) | undefined): void;
    /** Reports commands that ended without anyone waiting to hear about it. */
    setSessionExitListener?(listener: ((exit: BashSessionExit) => void) | undefined): void;
    startSession(options: Omit<BashRunOptions, "signal">): Promise<number>;
    supportsSessionInput: boolean;
    writeSession(sessionId: number, data: string | Uint8Array): Promise<boolean>;
}
