export interface RemoteTerminalProcessExit {
    exitCode: number | null;
}

export interface RemoteTerminalProcess {
    kill(): void | Promise<void>;
    onData(listener: (data: Uint8Array) => void): () => void;
    pause(): void;
    resize(cols: number, rows: number): void | Promise<void>;
    resume(): void;
    wait(): Promise<RemoteTerminalProcessExit>;
    write(data: string | Uint8Array): boolean | Promise<boolean>;
}

export interface RemoteTerminalProcessOptions {
    cols: number;
    command?: string;
    cwd: string;
    rows: number;
    shell?: string;
}

/**
 * Where a factory's processes actually run.
 *
 * This is not a description; it is the answer to whether a terminal may ever be
 * shown to somebody who is not the owner. A `host` terminal reaches the owner's
 * `~/.claude`, `~/.codex`, `~/.ssh`, `~/.aws`, the daemon's environment, and the
 * managed proxy, so no permission mode makes it safe to mirror to another
 * person. The factory declares it because the factory IS the decision — choosing
 * the Docker factory over the node one is what confines the process — and
 * anything that asks a project's configuration instead is asking a question
 * whose answer can drift away from the terminal that actually exists.
 */
export type RemoteTerminalConfinement = "container" | "host";

export interface RemoteTerminalProcessFactory {
    /** Where this factory's processes run. Fail closed: assume `host` if unsure. */
    readonly confinement: RemoteTerminalConfinement;
    start(options: RemoteTerminalProcessOptions): Promise<RemoteTerminalProcess>;
}
