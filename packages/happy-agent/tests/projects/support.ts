import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

import { withAgentDatabase, type AgentDatabase } from "@slopus/happy-agent-base";
import {
    ConfigModule,
    GitModule,
    projectMigrations,
    ProjectsModule,
    workspaceMigrations,
    WorkspacesModule,
    type GitCommandRunner,
    type WorkspaceFolderSettings,
} from "@slopus/happy-agent-modules";
import { createRootContext, withLogger, type Context, type RootContext } from "@steve.kite/stdlib";
import { drizzle } from "drizzle-orm/sqlite-proxy";

const execFile = promisify(execFileCallback);

/** This installation, which is what the projects catalog records on what it creates. */
export const INSTANCE_ID = "installation-test";

/** The few things a test wants to change about the pair of catalogs it drives. */
export interface ProjectCatalogOptions {
    /** Replaces Git for both catalogs, so a test can hold one command still. */
    readonly git?: GitCommandRunner;
    /**
     * What `[workspace]` says for this installation. Both catalogs read it from configuration, so
     * it is written into the harness's own `happy.toml` rather than handed to a module.
     */
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
    readonly git: GitModule;
    readonly projects: ProjectsModule;
    readonly workspaces: WorkspacesModule;
    readonly open: (ctx: Context) => Promise<void>;
    readonly close: (ctx: Context) => Promise<void>;
}

/** The temporary directories one test gets, plus everything it has to take down afterwards. */
export interface ProjectTestHarness extends ProjectCatalogs {
    readonly config: ConfigModule;
    readonly ctx: Context;
    /**
     * The folder the catalogs treat as this person's home. Git decides that from the real home
     * directory now, so a test that wants the home project asks for the same answer.
     */
    readonly home: string;
    readonly managedProjects: string;
    readonly managedWorkspaces: string;
    readonly root: string;
    readonly rootContext: RootContext;
    readonly stateDirectory: string;
    /** Every warning the catalogs logged, which is where a failed folder cleanup now reports. */
    readonly warnings: readonly string[];
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
 * Nothing here is a stand-in: the catalogs run their own migrations against SQLite, they read their
 * layout from a real `ConfigModule` rooted in the test's own folder, and they work on directories
 * under the system temporary folder. Git is the Git on this machine, because the behaviors under
 * test — worktrees, branches, prune — are Git's, not a mock's.
 */
export async function projectTestHarness(
    name: string,
    overrides: ProjectCatalogOptions = {},
): Promise<ProjectTestHarness> {
    // macOS hands out `/var/...` for a temporary directory but canonicalizes it to `/private/var`,
    // and the catalogs store canonical paths. Resolving here keeps the two the same string.
    const root = await realpath(await mkdtemp(join(tmpdir(), `rig-${name}-`)));
    const managedProjects = join(root, "managed-projects");
    const managedWorkspaces = join(root, "managed-workspaces");
    const config = await testConfiguration(root, managedProjects, managedWorkspaces, overrides);
    const stateDirectory = join(config.configuration.paths.agentHome, "projects");

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

    // A failed folder cleanup is reported by the catalog on its own lifetime's logger now, so the
    // harness listens where it actually lands instead of taking a callback.
    const warnings: string[] = [];
    const record = (...args: unknown[]): void => {
        warnings.push(args.map((value) => String(value)).join(" "));
    };
    const silent = (): void => undefined;
    // The catalogs start their own background work off this root, so the database has to be on the
    // root itself rather than on the context of whichever call happened to reach them first.
    const rootContext = withLogger(withAgentDatabase(createRootContext(), database), {
        trace: silent,
        debug: silent,
        info: silent,
        warn: (_context, ...args) => record(...args),
        error: (_context, ...args) => record(...args),
        fatal: (_context, ...args) => record(...args),
    }) as RootContext;
    const ctx = rootContext.named(name);
    for (const [, migrate] of projectMigrations) await migrate(ctx, database);
    for (const [, migrate] of workspaceMigrations) await migrate(ctx, database);

    const built: ProjectCatalogs[] = [];
    const create = (extra: ProjectCatalogOverrides = {}): ProjectCatalogs => {
        const settings: ProjectCatalogOverrides = { ...overrides, ...extra };
        const git =
            settings.git === undefined ? new GitModule() : GitModule.withRunner(settings.git);
        const projects = new ProjectsModule(config, git);
        const workspaces = new WorkspacesModule(config, projects, git);
        const pair: ProjectCatalogs = {
            git,
            projects,
            workspaces,
            open: async (openCtx) => {
                await projects.open(openCtx, INSTANCE_ID);
                await workspaces.open(openCtx);
            },
            // Workspaces close first: a workspace's cleanup reads the project it was cut from.
            close: async (closeCtx) => {
                await workspaces.close(closeCtx);
                await projects.close(closeCtx);
                git.dispose();
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
        config,
        ctx,
        dispose,
        git: current.git,
        home: current.projects.homeDirectory,
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
        warnings,
    };
}

/**
 * Configuration for one harness, rooted in the folder that harness owns.
 *
 * Where managed projects and workspaces live is the product's own mechanism —
 * `RIG_PROJECTS_DIRECTORY` and `RIG_WORKSPACES_DIRECTORY` — read once while those variables are
 * set, because configuration settles its layout once per installation and remembers it. Workspace
 * folder settings are written into the same `happy.toml` a person would edit.
 */
async function testConfiguration(
    root: string,
    managedProjects: string,
    managedWorkspaces: string,
    overrides: ProjectCatalogOptions,
): Promise<ConfigModule> {
    const previousProjects = process.env.RIG_PROJECTS_DIRECTORY;
    const previousWorkspaces = process.env.RIG_WORKSPACES_DIRECTORY;
    process.env.RIG_PROJECTS_DIRECTORY = managedProjects;
    process.env.RIG_WORKSPACES_DIRECTORY = managedWorkspaces;
    try {
        const happyHome = join(root, "happy");
        if (overrides.settings !== undefined) {
            const path = (await ConfigModule.load(happyHome)).configuration.paths.globalConfigPath;
            await mkdir(join(path, ".."), { recursive: true });
            await writeFile(path, workspaceSettingsToml(overrides.settings), "utf8");
        }
        const config = await ConfigModule.load(happyHome);
        void config.projectsHome;
        void config.workspacesHome;
        return config;
    } finally {
        restoreEnvironment("RIG_PROJECTS_DIRECTORY", previousProjects);
        restoreEnvironment("RIG_WORKSPACES_DIRECTORY", previousWorkspaces);
    }
}

function workspaceSettingsToml(settings: WorkspaceFolderSettings): string {
    const list = (values: readonly string[]): string =>
        `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
    return [
        "[workspace]",
        `keep_copies_on_archive = ${settings.keepCopiesOnArchive}`,
        `keep_worktrees_on_archive = ${settings.keepWorktreesOnArchive}`,
        `protected_sync = ${list(settings.protectedSync)}`,
        `setup_commands = ${list(settings.setupCommands)}`,
        `sync = ${list(settings.sync)}`,
        "",
    ].join("\n");
}

function restoreEnvironment(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
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
    const real = new GitModule();
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
                return await real.run(cwd, args, options);
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
