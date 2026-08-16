import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

import { withAgentDatabase, type AgentDatabase } from "@slopus/happy-agent-base";
import {
    projectMigrations,
    ProjectsModule,
    workspaceMigrations,
    WorkspacesModule,
} from "@slopus/happy-agent-modules";
import { createRootContext, type Context, type RootContext } from "@steve.kite/stdlib";
import { drizzle } from "drizzle-orm/sqlite-proxy";

import type { GitCommandRunner } from "../../sources/modules/git/GitCommandRunner.js";
import { directGitCommandRunner } from "../../sources/modules/git/runGitCommand.js";
import {
    ProjectWorkspaceService,
    type ProjectWorkspaceServiceOptions,
} from "../../sources/modules/projects/ProjectWorkspaceService.js";

const execFile = promisify(execFileCallback);

export const AGENT_ID = "agent-test";

/** The temporary directories one test gets, plus everything it has to take down afterwards. */
export interface ProjectTestHarness {
    readonly agentId: string;
    readonly ctx: Context;
    readonly home: string;
    readonly managedProjects: string;
    readonly managedWorkspaces: string;
    readonly projects: ProjectsModule;
    readonly root: string;
    readonly rootContext: RootContext;
    readonly service: ProjectWorkspaceService;
    readonly stateDirectory: string;
    readonly workspaces: WorkspacesModule;
    readonly dispose: () => Promise<void>;
    /**
     * Another service over the same catalogs and folders, which is what a restart looks like from
     * the database's point of view. Everything it starts is taken down with the harness.
     */
    readonly restart: (
        overrides?: Partial<ProjectWorkspaceServiceOptions>,
    ) => ProjectWorkspaceService;
}

/**
 * A real database, real modules and real folders.
 *
 * Nothing here is a stand-in: the catalogs run their own migrations against SQLite, and the
 * service works on directories under the system temporary folder. Git is the Git on this machine,
 * because the behaviors under test — worktrees, branches, prune — are Git's, not a mock's.
 */
export async function projectTestHarness(
    name: string,
    overrides: Partial<ProjectWorkspaceServiceOptions> = {},
): Promise<ProjectTestHarness> {
    // macOS hands out `/var/...` for a temporary directory but canonicalizes it to `/private/var`,
    // and the service stores canonical paths. Resolving here keeps the two the same string.
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

    const rootContext = createRootContext();
    const ctx = withAgentDatabase(rootContext.named(name), database);
    for (const [, migrate] of projectMigrations) await migrate(ctx, database);
    for (const [, migrate] of workspaceMigrations) await migrate(ctx, database);

    // The catalogs ask the host whether a branch or a folder key is taken and where an avatar's
    // bytes are, and the host that answers is the newest service. The lazy reference ties the knot.
    const services: ProjectWorkspaceService[] = [];
    const current = (): ProjectWorkspaceService | undefined => services[services.length - 1];
    const projects = new ProjectsModule({
        avatarAssetReader: {
            read: async (readCtx, readAgentId, hash) =>
                await current()?.avatarAssetReader.read(readCtx, readAgentId, hash),
        },
    });
    const workspaces = new WorkspacesModule({
        host: {
            pathForStorageKey: (projectRef, storageKey) =>
                current()?.workspaceCatalogHost.pathForStorageKey(projectRef, storageKey) ??
                join(managedWorkspaces, projectRef, storageKey),
            isBranchUnavailable: (projectRef, branch) =>
                current()?.workspaceCatalogHost.isBranchUnavailable(projectRef, branch) ?? false,
            isStorageKeyUnavailable: (projectRef, storageKey) =>
                current()?.workspaceCatalogHost.isStorageKeyUnavailable(projectRef, storageKey) ??
                false,
        },
    });

    const restart = (extra: Partial<ProjectWorkspaceServiceOptions> = {}) => {
        const created = new ProjectWorkspaceService({
            agentId: AGENT_ID,
            extendBackgroundContext: (background) => withAgentDatabase(background, database),
            homeDirectory: home,
            managedProjectsDirectory: managedProjects,
            projects,
            rootContext,
            stateDirectory,
            workspaces,
            workspacesDirectory: managedWorkspaces,
            ...overrides,
            ...extra,
        });
        services.push(created);
        return created;
    };
    const service = restart();

    const dispose = async (): Promise<void> => {
        for (const created of services) await created.close(ctx);
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
        projects,
        restart,
        root,
        rootContext,
        service,
        stateDirectory,
        workspaces,
    };
}

/**
 * The Git the machine has, wrapped so a test can hold one command still.
 *
 * An interrupted workspace creation cannot be staged after the fact — the catalog refuses to move
 * a failed workspace back to being created — so it has to be produced the way it really happens:
 * stop Git mid-checkout and take the service down while it is stopped.
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

/** Waits for a condition the service reaches in the background, or gives up with a clear failure. */
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
