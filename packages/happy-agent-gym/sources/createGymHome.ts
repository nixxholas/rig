import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";

/** A file a scenario starts with: text, bytes, or bytes with a mode that matters. */
export type GymFixture =
    | string
    | Uint8Array
    | { readonly content: string | Uint8Array; readonly mode?: number };

export interface GymHomeOptions {
    /** Files written into the agent's working directory before it starts. */
    readonly files?: Readonly<Record<string, GymFixture>>;
    /** Extra `happy.toml` content, appended after whatever the gym itself configures. */
    readonly config?: string;
    /** The permission mode sessions start in when a request does not name one. */
    readonly permissionMode?: "read_only" | "workspace_write" | "auto" | "full_access";
}

export interface GymHome {
    /** The throwaway folder holding both homes. */
    readonly root: string;
    /** Happy's private root, the folder `startHappyAgent` is pointed at. */
    readonly happyHome: string;
    /** The public home, which is both the agent's working directory and where fixtures land. */
    readonly workspacePath: string;
    /** Delete everything this home owns. */
    remove(): Promise<void>;
}

/**
 * A Unix socket path may not exceed roughly this many bytes, and the daemon's socket lives several
 * folders below the root. A gym would rather explain that up front than fail inside `listen`.
 */
const MAX_SOCKET_PATH = 100;

/**
 * Make one throwaway Happy installation.
 *
 * It lives under the repository's scratch folder rather than the system temporary directory
 * because the daemon's socket path is bounded, and macOS temporary paths are long enough on their
 * own to exhaust that bound.
 */
export async function createGymHome(options: GymHomeOptions = {}): Promise<GymHome> {
    const scratch = resolve(import.meta.dirname, "../../../.context/gym");
    await mkdir(scratch, { recursive: true });
    const root = await mkdtemp(join(scratch, "g-"));
    const happyHome = join(root, ".happy");
    const workspacePath = join(root, "Happy");
    const socketPath = join(happyHome, "agent", "server.sock");
    if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH) {
        await rm(root, { force: true, recursive: true });
        throw new Error(
            `A gym cannot start here: its socket path would be ${String(
                Buffer.byteLength(socketPath),
            )} bytes, and a Unix socket allows about ${String(MAX_SOCKET_PATH)}. ` +
                "Check the repository out somewhere shorter.",
        );
    }

    await mkdir(join(workspacePath, "Config"), { recursive: true });
    const config = [
        ...(options.permissionMode === undefined
            ? []
            : ["[defaults]", `permission_mode = "${options.permissionMode}"`, ""]),
        ...(options.config === undefined ? [] : [options.config, ""]),
    ].join("\n");
    if (config.trim().length > 0) {
        await writeFile(join(workspacePath, "Config", "happy.toml"), config, "utf8");
    }

    for (const [path, fixture] of Object.entries(options.files ?? {})) {
        const target = resolveFixturePath(workspacePath, path);
        await mkdir(join(target, ".."), { recursive: true });
        const { content, mode } = normalizeFixture(fixture);
        await writeFile(target, content, mode === undefined ? {} : { mode });
    }

    return {
        happyHome,
        remove: async () => await rm(root, { force: true, recursive: true }),
        root,
        workspacePath,
    };
}

/** Fixture paths are relative to the working directory, and may not point outside it. */
export function resolveFixturePath(workspacePath: string, path: string): string {
    if (isAbsolute(path)) {
        throw new Error(`A gym fixture path must be relative, but "${path}" is absolute.`);
    }
    const target = resolve(workspacePath, normalize(path));
    if (target !== workspacePath && !target.startsWith(workspacePath + sep)) {
        throw new Error(`A gym fixture path must stay inside the workspace, but "${path}" leaves.`);
    }
    return target;
}

function normalizeFixture(fixture: GymFixture): {
    content: string | Uint8Array;
    mode: number | undefined;
} {
    if (typeof fixture === "string" || fixture instanceof Uint8Array) {
        return { content: fixture, mode: undefined };
    }
    return { content: fixture.content, mode: fixture.mode };
}
