import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

import { withAgentDatabase, type AgentDatabase } from "@slopus/happy-agent-base";
import {
    directGitCommandRunner,
    projectMigrations,
    ProjectsModule,
    workspaceMigrations,
    WorkspacesModule,
    type GitCommandRunner,
    type WorkspaceFolderSettings,
} from "@slopus/happy-agent-modules";
import { createRootContext, type Context, type RootContext } from "@steve.kite/stdlib";
import { drizzle } from "drizzle-orm/sqlite-proxy";

const execFile = promisify(execFileCallback);

export const AGENT_ID = "agent-test";

/** The few things a test wants to change about the pair of catalogs it drives. */
export interface ProjectCatalogOptions {
    /** Replaces Git for both catalogs, so a test can hold one command still. */
    readonly git?: GitCommandRunner;
    readonly now?: () => number;
    readonly onWorkspaceHostError?: (
        workspaceId: string,
        kind: "archive" | "rename",
        message: string,
    ) => void;
    readonly settings?: WorkspaceFolderSettings;
}

/**
 * What a restart may change. A value given as `undefined` drops the override the first run had,
 * which is how a test asks for the real Git back after holding one command still.
 */
export type ProjectCatalogOverrides = {
    readonly [Key in keyof ProjectCatalogOptions]?: ProjectCatalogOptions[Key] | undefined;
};

/** One pair of catalogs over one database: what a single run of Rig has. */
export interface ProjectCatalogs {
    readonly projects: ProjectsModule;
    readonly workspaces: WorkspacesModule;
    readonly open: (ctx: Context) => Promise<void>;
    readonly close: (ctx: Context) => Promise<void>;
}

/** The temporary directories one test gets, plus everything it has to take down afterwards. */
export interface ProjectTestHarness extends ProjectCatalogs {
    readonly agentId: string;
    readonly ctx: Context;
    readonly home: string;
    readonly managedProjects: string;
    readonly managedWorkspaces: string;
    readonly root: string;
    readonly rootContext: RootContext;
    readonly stateDirectory: string;
    readonly dispose: () => Promise<void>;
    /**
     * Another pair of catalogs over the same database and folders, which is what a restart looks
     * like from the database's point of view. Everything it starts is taken down with the harness.
     */
    readonly restart: (overrides?: ProjectCatalogOverrides) => ProjectCatalogs;
}

/**
 * A real database, real modules and real folders.
 *
 * Nothing here is a stand-in: the catalogs run their own migrations against SQLite, and they work
 * on directories under the system temporary folder. Git is the Git on this machine, because the
 * behaviors under test — worktrees, branches, prune — are Git's, not a mock's.
 */
export async function projectTestHarness(
    name: string,
    overrides: ProjectCatalogOptions = {},
): Promise<ProjectTestHarness> {
    // macOS hands out `/var/...` for a temporary directory but canonicalizes it to `/private/var`,
    // and the catalogs store canonical paths. Resolving here keeps the two the same string.
    const root = await realpath(await mkdtemp(join(tmpdir(), `rig-${name}-`)));
    const home = join(root, "home");
    const managedProjects = join(root, "managed-projects");
    const managedWorkspaces = join(root, "managed-workspaces");
    const stateDirectory = join(root, "state");
    await execFile("mkdir", ["-p", home]);

    const sqlite = new DatabaseSync(":memory:");
    const database = drizzle(async (query, params, method) => {
        const statement = sqlite.prepare(query);
        if (method === "run") {
            statement.run(...params);
            return { rows: [] };
        }
        if (method === "get") {
            const row = statement.get(...params);
            return { rows: row === undefined ? [] : [row] };
        }
        if (method === "values") {
            statement.setReturnArrays(true);
            return { rows: statement.all(...params) };
        }
        return { rows: statement.all(...params) };
    }) as unknown as AgentDatabase;

    // The catalogs start their own background work off this root, so the database has to be on the
    // root itself rather than on the context of whichever call happened to reach them first.
    const rootContext = withAgentDatabase(createRootContext(), database) as RootContext;
    const ctx = rootContext.named(name);
    for (const [, migrate] of projectMigrations) await migrate(ctx, database);
    for (const [, migrate] of workspaceMigrations) await migrate(ctx, database);

    const built: ProjectCatalogs[] = [];
    const create = (extra: ProjectCatalogOverrides = {}): ProjectCatalogs => {
        const settings: ProjectCatalogOverrides = { ...overrides, ...extra };
        const projects = new ProjectsModule({
            homeDirectory: home,
            managedProjectsDirectory: managedProjects,
            rootContext,
            stateDirectory,
            ...(settings.git === undefined ? {} : { git: settings.git }),
            ...(settings.now === undefined ? {} : { now: settings.now }),
        });
        const workspaces = new WorkspacesModule({
            homeDirectory: home,
            projects,
            rootContext,
            workspacesDirectory: managedWorkspaces,
            ...(settings.git === undefined ? {} : { git: settings.git }),
            ...(settings.settings === undefined ? {} : { settings: settings.settings }),
            ...(settings.onWorkspaceHostError === undefined
                ? {}
                : {
                      onHostError: (_hostCtx, workspaceId, kind, message) => {
                          settings.onWorkspaceHostError?.(workspaceId, kind, message);
                      },
                  }),
        });
        const pair: ProjectCatalogs = {
            projects,
            workspaces,
            open: async (openCtx) => {
                await projects.open(openCtx, AGENT_ID);
                await workspaces.open(openCtx, AGENT_ID);
            },
            // Workspaces close first: a workspace's cleanup reads the project it was cut from.
            close: async (closeCtx) => {
                await workspaces.close(closeCtx);
                await projects.close(closeCtx);
            },
        };
        built.push(pair);
        return pair;
    };
    const current = create();

    const dispose = async (): Promise<void> => {
        for (const pair of built) await pair.close(ctx);
        sqlite.close();
        await rm(root, { force: true, recursive: true });
    };

    return {
        agentId: AGENT_ID,
        ctx,
        dispose,
        home,
        managedProjects,
        managedWorkspaces,
        projects: current.projects,
        workspaces: current.workspaces,
        open: current.open,
        close: current.close,
        restart: create,
        root,
        rootContext,
        stateDirectory,
    };
}

/**
 * The Git the machine has, wrapped so a test can hold one command still.
 *
 * An interrupted workspace creation cannot be staged after the fact — the catalog refuses to move
 * a failed workspace back to being created — so it has to be produced the way it really happens:
 * stop Git mid-checkout and take the catalogs down while it is stopped.
 */
export function pausableGit(pauseWhen: (args: readonly string[]) => boolean): {
    readonly runner: GitCommandRunner;
    readonly paused: Promise<void>;
    readonly release: () => void;
} {
    let announcePaused = (): void => undefined;
    const pausedPromise = new Promise<void>((resolve) => {
        announcePaused = () => resolve();
    });
    let releaseGate = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
        releaseGate = () => resolve();
    });
    return {
        paused: pausedPromise,
        release: () => releaseGate(),
        runner: {
            async run(cwd, args, options) {
                if (pauseWhen(args)) {
                    announcePaused();
                    await gate;
                    return { code: 128, stderr: "Git was interrupted.", stdout: "" };
                }
                return await directGitCommandRunner.run(cwd, args, options);
            },
        },
    };
}

/** Runs Git the way a person would, and fails loudly rather than returning a status code. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
    const result = await execFile("git", args, {
        cwd,
        env: {
            ...process.env,
            GIT_AUTHOR_EMAIL: "test@example.com",
            GIT_AUTHOR_NAME: "Test",
            GIT_COMMITTER_EMAIL: "test@example.com",
            GIT_COMMITTER_NAME: "Test",
        },
    });
    return result.stdout.trim();
}

/** A repository with one commit on `main`, which is the smallest thing a workspace can branch from. */
export async function createGitRepository(path: string): Promise<string> {
    await execFile("mkdir", ["-p", path]);
    await git(path, "init", "--initial-branch=main");
    await git(path, "config", "user.email", "test@example.com");
    await git(path, "config", "user.name", "Test");
    await writeFile(join(path, "README.md"), "# Test\n");
    await git(path, "add", ".");
    await git(path, "commit", "-m", "first");
    return path;
}

/** Waits for a condition the catalogs reach in the background, or gives up with a clear failure. */
export async function waitFor<Value>(
    read: () => Promise<Value | undefined>,
    describe: string,
    timeoutMs = 20_000,
): Promise<Value> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await read();
        if (value !== undefined) return value;
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${describe}.`);
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}
