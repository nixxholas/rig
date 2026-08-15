export type ManagedProcessStatus = "running" | "exited" | "killed";

export interface ProcessStartOptions {
    args?: readonly string[];
    command: string;
    cwd: string;
    shell?: string;
    env?: NodeJS.ProcessEnv;
    /** Trusted bytes sent over inherited descriptors 3 and above before the process is returned. */
    extraFileDescriptorInputs?: readonly (string | Uint8Array)[];
    /** Bytes written to stdin immediately after spawn, before caller-owned input. */
    initialStdin?: string | Uint8Array;
    /**
     * A PTY wrapper's private startup handshake.
     *
     * Terminal input is echoed by default, so trusted startup bytes must wait until the wrapper
     * disables echo and emits `readyMarker`. The wrapper emits `completeMarker` after consuming the
     * bytes and restoring the terminal; neither marker is exposed as command output.
     */
    initialStdinHandshake?: {
        completeMarker: string;
        readyMarker: string;
    };
    maxOutputBytes?: number;
    /** Run the command under a pseudo-terminal instead of pipes. */
    tty?: boolean;
}

export interface ProcessRunOptions extends ProcessStartOptions {
    timeoutMs?: number;
    killGraceMs?: number;
    signal?: AbortSignal;
}

export interface ProcessKillOptions {
    forceAfterMs?: number;
    /** Also stop work deliberately left running in the background. */
    includeDetached?: boolean;
}

export interface ProcessSnapshot {
    id: string;
    pid: number | null;
    command: string;
    cwd: string;
    status: ManagedProcessStatus;
    stdout: string;
    stderr: string;
    stdoutBytes?: number;
    stderrBytes?: number;
    stdoutOmittedBytes?: number;
    stderrOmittedBytes?: number;
}

export interface ProcessRunResult extends ProcessSnapshot {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    aborted: boolean;
    killed: boolean;
}
