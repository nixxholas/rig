import type {
    Compute,
    ComputeFileStat,
    ComputeFileSystem,
    ComputePermissions,
    ComputeRunOptions,
    ComputeSessionActivity,
    ComputeSessionReadOptions,
    ComputeSessionSnapshot,
    ComputeSessionStatus,
    ComputeShell,
} from "../../../sources/index.js";

/** How one command behaves when the tools run it. */
export interface ScriptedCommand {
    /** Output handed back one piece per read, so a second read can return something new. */
    readonly chunks?: readonly string[];
    /** The code it ends with once its output has run out. */
    readonly exitCode?: number;
    /** Keep running after the output runs out, the way a server does. */
    readonly keepRunning?: boolean;
    /** What it prints in answer to what is typed into it. */
    readonly answer?: (input: string) => string;
}

/** One command the fake shell is running or has run. */
interface FakeSession {
    readonly command: string;
    readonly cwd: string;
    readonly script: ScriptedCommand;
    readonly sessionId: number;
    /** Output produced but not yet read. */
    pending: string;
    /** Output still to be produced, one piece per read. */
    remaining: string[];
    status: ComputeSessionStatus;
    exitCode: number | null;
}

/** What one file holds, and when it last changed. */
interface FakeFile {
    content: string;
    mtimeMs: number;
}

/**
 * A machine made of a few maps: files in memory, and commands that produce exactly what a test
 * says they produce.
 *
 * It implements the structural compute the tools are written against rather than the real
 * package, which is the point of that interface — the tools can be driven through every path
 * that matters without a filesystem, a shell, or a container anywhere near the test.
 */
export class FakeCompute implements Compute {
    readonly cwd: string;
    readonly fs: ComputeFileSystem;
    readonly shell: ComputeShell;
    readonly permissions: ComputePermissions;

    /** Every file, by absolute path. */
    readonly files = new Map<string, FakeFile>();
    /** Every directory, by absolute path. */
    readonly directories = new Set<string>();
    /** Where a symbolic link really leads, by absolute path. */
    readonly links = new Map<string, string>();
    /** What each command does, by the exact command line. */
    readonly commands = new Map<string, ScriptedCommand>();
    /** Every command the shell has run. */
    readonly sessions: FakeSession[] = [];
    /** Commands the tools asked to keep running past the end of a turn. */
    readonly detached = new Set<number>();
    /** Paths the machine guards even inside the workspace. */
    protectedPaths: string[] = [];
    /** Whether the machine refuses to change anything at all. */
    readOnly = false;

    /** Modification times come from a counter, so "changed since read" is exact. */
    #clock = 1_000;

    constructor(cwd = "/workspace") {
        this.cwd = cwd;
        this.directories.add(cwd);
        this.fs = this.#createFileSystem();
        this.shell = this.#createShell();
        this.permissions = { protectedPaths: () => this.protectedPaths };
    }

    /** Put a file on the machine, as though somebody else had written it. */
    write(path: string, content: string): void {
        this.#clock += 1_000;
        this.files.set(path, { content, mtimeMs: this.#clock });
        let directory = parent(path);
        while (directory !== "" && !this.directories.has(directory)) {
            this.directories.add(directory);
            directory = parent(directory);
        }
    }

    /** Teach the shell one command. */
    script(command: string, script: ScriptedCommand): void {
        this.commands.set(command, script);
    }

    #createFileSystem(): ComputeFileSystem {
        const statOf = (path: string): ComputeFileStat | undefined => {
            const file = this.files.get(path);
            if (file !== undefined) {
                return {
                    isFile: true,
                    isDirectory: false,
                    isSymbolicLink: false,
                    size: file.content.length,
                    mtimeMs: file.mtimeMs,
                };
            }
            if (this.directories.has(path)) {
                return {
                    isFile: false,
                    isDirectory: true,
                    isSymbolicLink: false,
                    size: 0,
                    mtimeMs: 0,
                };
            }
            return undefined;
        };
        return {
            cwd: this.cwd,
            home: "/home/agent",
            exists: (path) => Promise.resolve(statOf(path) !== undefined),
            lstatMany: (paths) => Promise.resolve(paths.map((path) => statOf(path))),
            mkdir: (path) => {
                let directory = path;
                while (directory !== "" && !this.directories.has(directory)) {
                    this.directories.add(directory);
                    directory = parent(directory);
                }
                return Promise.resolve();
            },
            readFile: (path) => {
                const file = this.files.get(path);
                return file === undefined
                    ? Promise.reject(new Error(`No such file: ${path}`))
                    : Promise.resolve(file.content);
            },
            readdir: (path) => {
                if (!this.directories.has(path)) {
                    return Promise.reject(new Error(`No such directory: ${path}`));
                }
                const prefix = path.endsWith("/") ? path : `${path}/`;
                const names = new Set<string>();
                for (const candidate of [...this.files.keys(), ...this.directories]) {
                    if (!candidate.startsWith(prefix) || candidate === path) continue;
                    names.add(candidate.slice(prefix.length).split("/")[0] ?? "");
                }
                return Promise.resolve([...names]);
            },
            realpath: (path) => {
                const target = this.links.get(path);
                if (target !== undefined) return Promise.resolve(target);
                return statOf(path) === undefined
                    ? Promise.reject(new Error(`No such path: ${path}`))
                    : Promise.resolve(path);
            },
            stat: (path) => {
                const stat = statOf(path);
                return stat === undefined
                    ? Promise.reject(new Error(`No such path: ${path}`))
                    : Promise.resolve(stat);
            },
            writeFile: (path, content) => {
                if (this.readOnly) {
                    return Promise.reject(
                        new Error("This machine is read-only: nothing may be changed."),
                    );
                }
                this.write(path, content);
                return Promise.resolve();
            },
        };
    }

    #createShell(): ComputeShell {
        const sessionOf = (sessionId: number): FakeSession | undefined =>
            this.sessions.find((session) => session.sessionId === sessionId);
        const snapshotOf = (session: FakeSession, delta: string): ComputeSessionSnapshot => ({
            command: session.command,
            cwd: session.cwd,
            exitCode: session.status === "running" ? null : session.exitCode,
            sessionId: session.sessionId,
            status: session.status,
            stderrDelta: "",
            stdoutDelta: delta,
            timedOut: false,
        });
        return {
            activeSessions: (): readonly ComputeSessionActivity[] =>
                this.sessions
                    .filter((session) => session.status === "running")
                    .map((session) => ({
                        command: session.command,
                        cwd: session.cwd,
                        sessionId: session.sessionId,
                        status: "running" as const,
                    })),
            detachSession: (sessionId) => {
                this.detached.add(sessionId);
            },
            killSession: (sessionId) => {
                const session = sessionOf(sessionId);
                if (session === undefined) return Promise.resolve(undefined);
                session.status = "killed";
                session.exitCode = null;
                return Promise.resolve(snapshotOf(session, session.pending));
            },
            readSession: (sessionId: number, options?: ComputeSessionReadOptions) => {
                const session = sessionOf(sessionId);
                if (session === undefined) return Promise.resolve(undefined);
                if (session.status === "running") {
                    const next = session.remaining.shift();
                    if (next !== undefined) session.pending += next;
                    if (session.remaining.length === 0 && session.script.keepRunning !== true) {
                        session.status = "completed";
                        session.exitCode = session.script.exitCode ?? 0;
                    }
                }
                const delta = session.pending;
                if (options?.peek !== true) session.pending = "";
                return Promise.resolve(snapshotOf(session, delta));
            },
            startSession: (options: ComputeRunOptions) => {
                const script = this.commands.get(options.command);
                if (script === undefined) {
                    return Promise.reject(
                        new Error(`This test never scripted the command: ${options.command}`),
                    );
                }
                const session: FakeSession = {
                    command: options.command,
                    cwd: options.cwd ?? this.cwd,
                    script,
                    sessionId: this.sessions.length + 1,
                    pending: "",
                    remaining: [...(script.chunks ?? [])],
                    status: "running",
                    exitCode: null,
                };
                this.sessions.push(session);
                return Promise.resolve(session.sessionId);
            },
            supportsSessionInput: true,
            writeSession: (sessionId, data) => {
                const session = sessionOf(sessionId);
                if (session === undefined || session.status !== "running") {
                    return Promise.resolve(false);
                }
                session.remaining.push(session.script.answer?.(data) ?? data);
                return Promise.resolve(true);
            },
        };
    }
}

/** The directory holding a path, in the fake machine's own flat namespace. */
function parent(path: string): string {
    const cut = path.lastIndexOf("/");
    return cut <= 0 ? "" : path.slice(0, cut);
}
