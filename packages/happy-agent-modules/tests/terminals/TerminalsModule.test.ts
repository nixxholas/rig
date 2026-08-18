import { PassThrough } from "node:stream";

import type { Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { GitModule } from "../../sources/git/index.js";
import { projectMigrations, ProjectsModule } from "../../sources/projects/index.js";
import {
    MAX_TERMINALS_PER_SCOPE,
    TerminalError,
    TerminalsModule,
    type TerminalProcess,
    type TerminalProcessFactory,
    type TerminalProcessOptions,
} from "../../sources/terminals/index.js";
import { workspaceMigrations, WorkspacesModule } from "../../sources/workspaces/index.js";
import { temporaryTestConfig } from "../support/configModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

const opened: World[] = [];

afterEach(async () => {
    for (const world of opened.splice(0)) {
        await world.module.close();
        world.close();
    }
});

describe("TerminalsModule", () => {
    it("opens a terminal in the project's own folder and lists it back", async () => {
        const { ctx, factory, module, project } = await createWorld("terminals-project-folder");

        const terminal = await module.create(
            ctx,
            { projectId: project.id },
            { cols: 40, rows: 12 },
        );

        expect(terminal.status).toBe("running");
        expect(terminal.cols).toBe(40);
        expect(terminal.rows).toBe(12);
        expect(terminal.colorScheme).toBe("dark");
        expect(terminal.exitCode).toBeNull();
        expect(factory.started[0]?.cwd).toBe(project.repositoryRef);
        expect(await module.list(ctx, { projectId: project.id })).toEqual([terminal]);
    });

    it("starts a workspace terminal in the worktree rather than inside the project", async () => {
        const { ctx, factory, module, project, workspace, workspacesDirectory } = await createWorld(
            "terminals-workspace-folder",
        );
        const scope = { projectId: project.id, workspaceId: workspace.id };

        await module.create(ctx, scope, {});

        expect(factory.started[0]?.cwd).toBe(workspace.path);
        expect(workspace.path.startsWith(workspacesDirectory)).toBe(true);
        // The two folders are two collections: a project terminal is not a workspace terminal.
        expect(await module.list(ctx, { projectId: project.id })).toEqual([]);
        expect(await module.list(ctx, scope)).toHaveLength(1);
    });

    it("resolves a relative working directory against the folder, and keeps an absolute one", async () => {
        const { ctx, factory, module, project } = await createWorld("terminals-cwd");

        await module.create(ctx, { projectId: project.id }, { cwd: "packages/thing" });
        await module.create(ctx, { projectId: project.id }, { cwd: "/somewhere/else" });

        expect(factory.started.map((options) => options.cwd)).toEqual([
            `${project.repositoryRef}/packages/thing`,
            "/somewhere/else",
        ]);
    });

    it("refuses a project, a workspace, and a terminal nobody has", async () => {
        const { ctx, module, project } = await createWorld("terminals-unknown");

        await expect(module.list(ctx, { projectId: "missing" })).rejects.toMatchObject({
            code: "not_found",
        });
        await expect(
            module.create(ctx, { projectId: project.id, workspaceId: "missing" }, {}),
        ).rejects.toMatchObject({ code: "not_found" });
        await expect(module.get(ctx, { projectId: project.id }, "nope")).rejects.toMatchObject({
            code: "not_found",
        });
    });

    it("refuses a workspace that is not ready and an archived project", async () => {
        const { archivedProject, ctx, initializingWorkspace, module, project } =
            await createWorld("terminals-not-usable");

        await expect(
            module.create(
                ctx,
                { projectId: project.id, workspaceId: initializingWorkspace.id },
                {},
            ),
        ).rejects.toMatchObject({ code: "conflict" });
        await expect(
            module.create(ctx, { projectId: archivedProject.id }, {}),
        ).rejects.toMatchObject({ code: "conflict" });
    });

    it("refuses a workspace that belongs to another project", async () => {
        const { ctx, module, otherProject, workspace } = await createWorld(
            "terminals-foreign-workspace",
        );

        await expect(
            module.create(ctx, { projectId: otherProject.id, workspaceId: workspace.id }, {}),
        ).rejects.toMatchObject({ code: "not_found" });
    });

    it("resizes the process and the record together", async () => {
        const { ctx, factory, module, project } = await createWorld("terminals-resize");
        const scope = { projectId: project.id };
        const created = await module.create(ctx, scope, {});

        const resized = await module.resize(ctx, scope, created.id, { cols: 100, rows: 30 });

        expect(resized).toMatchObject({ cols: 100, id: created.id, rows: 30 });
        expect(factory.processes[0]?.sizes.at(-1)).toEqual([100, 30]);
    });

    it("keeps a stopped terminal, holding what it exited with", async () => {
        const { ctx, factory, module, project } = await createWorld("terminals-exit-code");
        const scope = { projectId: project.id };
        const created = await module.create(ctx, scope, {});
        factory.processes[0]?.exitWith(3);

        const stopped = await module.stop(ctx, scope, created.id);

        expect(stopped).toMatchObject({ exitCode: 3, id: created.id, status: "exited" });
        expect(await module.list(ctx, scope)).toEqual([stopped]);
    });

    it("refuses one terminal past the limit, then reuses the place a finished one gave up", async () => {
        const { ctx, factory, module, project } = await createWorld("terminals-limit");
        const scope = { projectId: project.id };
        const first = await module.create(ctx, scope, {});
        for (let opened = 1; opened < MAX_TERMINALS_PER_SCOPE; opened += 1) {
            await module.create(ctx, scope, {});
        }

        await expect(module.create(ctx, scope, {})).rejects.toMatchObject({
            code: "conflict",
        });

        factory.processes[0]?.exitWith(0);
        await module.stop(ctx, scope, first.id);
        const replacement = await module.create(ctx, scope, {});

        const listed = await module.list(ctx, scope);
        expect(listed).toHaveLength(MAX_TERMINALS_PER_SCOPE);
        expect(listed.map((terminal) => terminal.id)).toContain(replacement.id);
        expect(listed.map((terminal) => terminal.id)).not.toContain(first.id);
    });

    it("ends a folder's terminals when that folder goes away", async () => {
        const { ctx, factory, module, project, workspace } =
            await createWorld("terminals-close-folder");
        const workspaceScope = { projectId: project.id, workspaceId: workspace.id };
        await module.create(ctx, { projectId: project.id }, {});
        await module.create(ctx, workspaceScope, {});

        await module.closeScope(workspaceScope);

        expect(factory.processes[1]?.killed).toBe(true);
        expect(factory.processes[0]?.killed).toBe(false);
        expect(await module.list(ctx, workspaceScope)).toEqual([]);

        await module.closeProject(project.id);
        expect(factory.processes[0]?.killed).toBe(true);
    });

    it("attaches a stream and detaches it again", async () => {
        const { ctx, module, project } = await createWorld("terminals-attach");
        const scope = { projectId: project.id };
        const created = await module.create(ctx, scope, {});
        const stream = new PassThrough();

        const detach = await module.attach(ctx, scope, created.id, stream);
        detach();
        stream.destroy();

        expect(typeof detach).toBe("function");
    });

    it("refuses settings that are not terminal settings at all", async () => {
        const { ctx, module, project } = await createWorld("terminals-invalid-settings");
        const scope = { projectId: project.id };

        await expect(module.create(ctx, scope, { cols: 0 })).rejects.toBeInstanceOf(TerminalError);
        await expect(
            module.create(ctx, scope, {
                nonsense: true,
            } as unknown as Record<string, never>),
        ).rejects.toMatchObject({ code: "invalid" });
    });

    it("opens nothing once it has closed", async () => {
        const { ctx, module, project } = await createWorld("terminals-closed");
        await module.close();

        await expect(module.create(ctx, { projectId: project.id }, {})).rejects.toMatchObject({
            code: "unavailable",
        });
    });
});

interface World {
    /** A project whose folder no terminal may stand in any more. */
    readonly archivedProject: { readonly id: string };
    readonly close: () => void;
    readonly ctx: Context;
    readonly factory: FakeProcessFactory;
    /** A workspace whose folder is not usable yet, because the catalog is still making it. */
    readonly initializingWorkspace: { readonly id: string };
    /** A second project, so a workspace of the first one is foreign to it. */
    readonly otherProject: { readonly id: string };
    readonly module: TerminalsModule;
    readonly project: { readonly id: string; readonly repositoryRef: string };
    readonly workspace: { readonly id: string; readonly path: string };
    /**
     * Where this world's workspace folders live, as the catalog itself resolves it: configuration
     * says where the managed root is, and Git settles what that path really names.
     */
    readonly workspacesDirectory: string;
}

/**
 * The two catalogs a terminal asks, as themselves.
 *
 * A terminal's folder is whatever the projects and workspaces catalogs say it is, so this drives the
 * real ones over a real agent database rather than restating their answers in a stand-in that could
 * drift from them. Only the pseudo-terminal is replaced, because a shell is not what is under test.
 */
async function createWorld(name: string): Promise<World> {
    const database = moduleDatabase([], name);
    for (const [, migrate] of projectMigrations) {
        await migrate(database.context, database.database);
    }
    for (const [, migrate] of workspaceMigrations) {
        await migrate(database.context, database.database);
    }

    const ctx = database.context;
    const config = await temporaryTestConfig();
    const git = new GitModule();
    const projects = new ProjectsModule(config, git);
    const workspaces = new WorkspacesModule(config, projects, git);

    const project = await projects.create(ctx, {
        name: "Main",
        repositoryRef: "/projects/main",
    });
    const otherProject = await projects.create(ctx, {
        name: "Other",
        repositoryRef: "/projects/other",
    });
    const gone = await projects.create(ctx, {
        name: "Gone",
        repositoryRef: "/projects/gone",
    });
    const archivedProject = await projects.archive(ctx, gone.id);

    const reserved = await workspaces.reserve(ctx, {
        name: "Ready",
        projectRef: project.id,
    });
    const workspace = await workspaces.markReady(ctx, {
        workspaceId: reserved.workspace.id,
    });
    const initializing = await workspaces.reserve(ctx, {
        name: "Starting",
        projectRef: project.id,
    });

    const factory = new FakeProcessFactory();
    const module = TerminalsModule.withProcessFactory(projects, workspaces, factory);

    const world: World = {
        archivedProject,
        close: database.close,
        ctx,
        factory,
        initializingWorkspace: initializing.workspace,
        module,
        otherProject,
        project,
        workspace,
        workspacesDirectory: git.normalizeFuturePath(config.workspacesHome),
    };
    opened.push(world);
    return world;
}

/** A process that never exists: the module's own behavior, with no shell in the way. */
class FakeProcess implements TerminalProcess {
    killed = false;
    readonly sizes: [number, number][] = [];
    readonly written: string[] = [];
    #listener: ((data: Uint8Array) => void) | undefined;
    #resolve: ((value: { exitCode: number | null }) => void) | undefined;
    readonly #exit = new Promise<{ exitCode: number | null }>((resolve) => {
        this.#resolve = resolve;
    });

    exitWith(exitCode: number | null): void {
        this.#resolve?.({ exitCode });
    }

    kill(): void {
        this.killed = true;
        this.exitWith(null);
    }

    onData(listener: (data: Uint8Array) => void): () => void {
        this.#listener = listener;
        return () => {
            if (this.#listener === listener) this.#listener = undefined;
        };
    }

    pause(): void {}

    resize(cols: number, rows: number): void {
        this.sizes.push([cols, rows]);
    }

    resume(): void {}

    wait(): Promise<{ exitCode: number | null }> {
        return this.#exit;
    }

    write(data: string | Uint8Array): boolean {
        this.written.push(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
        return true;
    }
}

class FakeProcessFactory implements TerminalProcessFactory {
    readonly processes: FakeProcess[] = [];
    readonly started: TerminalProcessOptions[] = [];

    async start(options: TerminalProcessOptions): Promise<TerminalProcess> {
        this.started.push(options);
        const process = new FakeProcess();
        this.processes.push(process);
        return process;
    }
}
