/**
 * The machine these tools work on, as the least of it they actually need.
 *
 * The real thing lives in `@slopus/happy-agent-compute`, and this is deliberately not imported
 * from there: this package does not depend on that one, and a feature should not force every
 * consumer to take a package for a handful of types it only reads. So the members below are
 * copied from that package's own `Compute`, `ComputeFileSystem`, `ComputeShell`, and
 * `ComputePermissions`, narrowed to what these tools call. They are structural on purpose — a
 * real compute satisfies them with nothing to adapt, and so does anything else that answers the
 * same calls, which is what lets the tests drive the tools with files in memory and a scripted
 * shell. Anything drifting from the real shapes shows up as a type error at the call site that
 * hands a compute to the feature.
 */

/** What a path is, as every backend reports it. */
export interface ComputeFileStat {
    isFile: boolean;
    isDirectory: boolean;
    isSymbolicLink: boolean;
    size: number;
    mtimeMs: number;
}

/** The filesystem the agent works in, whichever machine it is really on. */
export interface ComputeFileSystem {
    /** The directory relative paths resolve against. */
    cwd: string;
    /** The home directory, when the backend has one. */
    home?: string;
    exists(path: string): Promise<boolean>;
    /** Inspect a bounded set of paths. Implementations may batch remote work. */
    lstatMany(paths: readonly string[]): Promise<readonly (ComputeFileStat | undefined)[]>;
    mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
    readFile(path: string): Promise<string>;
    readdir(path: string): Promise<readonly string[]>;
    realpath(path: string): Promise<string>;
    stat(path: string): Promise<ComputeFileStat>;
    writeFile(path: string, content: string): Promise<void>;
}

/** What to run, and how patiently. */
export interface ComputeRunOptions {
    command: string;
    cwd?: string;
    maxOutputBytes?: number;
    timeoutMs?: number;
    /** Run the command under a pseudo-terminal instead of pipes. */
    tty?: boolean;
}

/** Whether a command is still going, finished on its own, or was stopped. */
export type ComputeSessionStatus = "completed" | "killed" | "running";

/** A command's state and output, including what is new since it was last read. */
export interface ComputeSessionSnapshot {
    command: string;
    cwd: string;
    exitCode: number | null;
    sessionId: number;
    status: ComputeSessionStatus;
    stderrDelta: string;
    stderrDeltaOmittedBytes?: number;
    stdoutDelta: string;
    stdoutDeltaOmittedBytes?: number;
    timedOut: boolean;
}

/** How to read a running command. */
export interface ComputeSessionReadOptions {
    /**
     * Look without consuming. The delta cursor belongs to the agent, so observers such as a
     * terminal viewer must not advance it.
     */
    peek?: boolean;
    signal?: AbortSignal;
    waitMs?: number;
}

/** A command that is still running, as a person listing them sees it. */
export interface ComputeSessionActivity {
    command: string;
    cwd: string;
    sessionId: number;
    status: "running";
}

/**
 * The shell the agent runs commands in. Reaching a timeout backgrounds a command rather than
 * killing it, so every command starts as a session the agent can come back to.
 */
export interface ComputeShell {
    /** The commands running right now, for a person looking at them. */
    activeSessions?(): readonly ComputeSessionActivity[];
    /**
     * Mark a session as work the agent means to leave running, so interrupting the turn no
     * longer stops it.
     */
    detachSession?(sessionId: number): void;
    killSession(sessionId: number): Promise<ComputeSessionSnapshot | undefined>;
    readSession(
        sessionId: number,
        options?: ComputeSessionReadOptions,
    ): Promise<ComputeSessionSnapshot | undefined>;
    startSession(options: ComputeRunOptions): Promise<number>;
    /** Whether characters can be sent to a running command's input. */
    supportsSessionInput: boolean;
    writeSession(sessionId: number, data: string): Promise<boolean>;
}

/** The part of the permission boundary a tool has to weigh before it acts. */
export interface ComputePermissions {
    /**
     * Absolute paths that require full access to modify even inside the workspace, such as Git
     * control files and the repository configuration that grants network access.
     */
    protectedPaths(): readonly string[];
}

/** One filesystem, one shell, and the boundary over both. */
export interface Compute {
    /** The directory the agent works in, in this machine's own paths. */
    readonly cwd: string;
    readonly fs: ComputeFileSystem;
    readonly shell: ComputeShell;
    readonly permissions: ComputePermissions;
}
