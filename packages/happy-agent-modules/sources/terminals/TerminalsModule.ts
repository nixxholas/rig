import type { Duplex } from "node:stream";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { mapAsyncLock, type Context, type MapAsyncLock } from "@steve.kite/stdlib";

import { ProjectsModule } from "../projects/index.js";
import { WorkspacesModule } from "../workspaces/index.js";

import {
    createTerminalInputSchema,
    resizeTerminalInputSchema,
    terminalScopeSchema,
    TerminalError,
    type CreateTerminalInput,
    type ResizeTerminalInput,
    type Terminal,
    type TerminalScope,
} from "./Terminal.js";
import type { TerminalProcessFactory } from "./TerminalProcess.js";
import { createHostTerminalProcessFactory } from "./impl/createHostTerminalProcessFactory.js";
import { TerminalCollection } from "./impl/TerminalCollection.js";
import type { TerminalSession } from "./impl/TerminalSession.js";

/**
 * Interactive terminals on a project or one of its workspaces.
 *
 * A terminal here is not an agent's shell command and not a chat: it is a real pseudo-terminal a
 * person types into, and everyone looking at the same folder sees the same collection of them. The
 * module owns the process, the one canonical Ghostty emulator behind it, and the protocol that
 * keeps every attached replica in step; a caller supplies only the folder's identity and gets back
 * a record and a stream to attach.
 *
 * Nothing here is durable. A terminal is a running process and a live screen, and both end with the
 * daemon, so there is no record to restore and none is kept.
 */
export class TerminalsModule {
    readonly name = "terminals";

    readonly #locks: MapAsyncLock<string> = mapAsyncLock<string>();
    readonly #projects: ProjectsModule;
    readonly #scopes = new Map<string, TerminalCollection>();
    readonly #workspaces: WorkspacesModule;
    #closed = false;
    #processFactory: TerminalProcessFactory;

    /**
     * @param projects The catalog that owns where a project's checkout is. A terminal stands in a
     * folder someone else decided on, so it asks the catalog that decided rather than deriving a
     * path of its own.
     * @param workspaces The catalog that owns where a managed worktree is and whether it is usable.
     * A workspace folder is not inside its project's, and it only exists once the catalog says the
     * workspace is ready, so both answers have to come from here.
     */
    constructor(projects: ProjectsModule, workspaces: WorkspacesModule) {
        this.#projects = projects;
        this.#workspaces = workspaces;
        this.#processFactory = createHostTerminalProcessFactory();
    }

    /**
     * Test-only construction over one supplied pseudo-terminal boundary.
     *
     * Production always spawns a real pseudo-terminal. A test that needs to drive the lifecycle
     * without a shell replaces the boundary here instead of reaching into the module.
     */
    static withProcessFactory(
        projects: ProjectsModule,
        workspaces: WorkspacesModule,
        processFactory: TerminalProcessFactory,
    ): TerminalsModule {
        const module = new TerminalsModule(projects, workspaces);
        module.#processFactory = processFactory;
        return module;
    }

    /** Open one terminal in a project or workspace folder. */
    async create(
        ctx: Context,
        scope: TerminalScope,
        input: CreateTerminalInput,
    ): Promise<Terminal> {
        assertScope(scope);
        if (!Value.Check(createTerminalInputSchema, input)) {
            throw new TerminalError("invalid", "The terminal settings are invalid.");
        }
        const collection = await this.#collection(ctx, scope);
        const session = await collection.create(input);
        return session.terminal();
    }

    /** Every terminal open on this folder right now. */
    async list(ctx: Context, scope: TerminalScope): Promise<readonly Terminal[]> {
        assertScope(scope);
        // Resolving first is what makes an unknown project or workspace a refusal rather than an
        // empty list that looks like a folder with nothing open in it.
        await this.#root(ctx, scope);
        return this.#scopes.get(scopeKey(scope))?.list() ?? [];
    }

    /** One terminal's current record. */
    async get(
        ctx: Context,
        scope: TerminalScope,
        terminalId: string,
    ): Promise<Terminal> {
        return (await this.session(ctx, scope, terminalId)).terminal();
    }

    /**
     * The live terminal, for a caller that is about to attach a stream to it.
     *
     * Attaching needs the session itself rather than its record, because the protocol — not this
     * module — owns what a new viewer is sent and in what order.
     */
    async session(
        ctx: Context,
        scope: TerminalScope,
        terminalId: string,
    ): Promise<TerminalSession> {
        assertScope(scope);
        await this.#root(ctx, scope);
        const session = this.#scopes.get(scopeKey(scope))?.get(terminalId);
        if (session === undefined) {
            throw new TerminalError("not_found", "The terminal was not found.");
        }
        return session;
    }

    /** Attach one stream, returning the call that detaches it again. */
    async attach(
        ctx: Context,
        scope: TerminalScope,
        terminalId: string,
        stream: Duplex,
    ): Promise<() => void> {
        const session = await this.session(ctx, scope, terminalId);
        return session.attach(stream);
    }

    async resize(
        ctx: Context,
        scope: TerminalScope,
        terminalId: string,
        input: ResizeTerminalInput,
    ): Promise<Terminal> {
        if (!Value.Check(resizeTerminalInputSchema, input)) {
            throw new TerminalError("invalid", "The terminal size is invalid.");
        }
        const session = await this.session(ctx, scope, terminalId);
        return await session.resize(input.cols, input.rows);
    }

    /** Stop the process. The record stays, holding the exit code, until the terminal is evicted. */
    async stop(
        ctx: Context,
        scope: TerminalScope,
        terminalId: string,
    ): Promise<Terminal> {
        const session = await this.session(ctx, scope, terminalId);
        return await session.stop();
    }

    /**
     * End every terminal on one folder.
     *
     * Archiving a workspace removes the folder its terminals are standing in, so the host calls
     * this as part of that decision rather than leaving shells in a directory that is gone.
     */
    async closeScope(scope: TerminalScope): Promise<void> {
        assertScope(scope);
        const key = scopeKey(scope);
        const collection = this.#scopes.get(key);
        if (collection === undefined) return;
        this.#scopes.delete(key);
        await collection.dispose();
    }

    /** End every terminal of a project, including those of its workspaces. */
    async closeProject(projectId: string): Promise<void> {
        const closing = [...this.#scopes.entries()].filter(
            ([, collection]) => collection.projectId === projectId,
        );
        for (const [key] of closing) this.#scopes.delete(key);
        await Promise.all(closing.map(async ([, collection]) => await collection.dispose()));
    }

    /** Stop everything. Nothing opens after this. */
    async close(): Promise<void> {
        this.#closed = true;
        const collections = [...this.#scopes.values()];
        this.#scopes.clear();
        await Promise.all(collections.map(async (collection) => await collection.dispose()));
    }

    /**
     * The collection for one folder, created on first use.
     *
     * Two people opening the first terminal of the same project at the same moment must end up in
     * one collection, or the limit and the listing would each describe half of the truth.
     */
    async #collection(
        ctx: Context,
        scope: TerminalScope,
    ): Promise<TerminalCollection> {
        const key = scopeKey(scope);
        const root = await this.#root(ctx, scope);
        return await this.#locks.runInLock(ctx, key, async () => {
            if (this.#closed) {
                throw new TerminalError("unavailable", "The Happy agent is shutting down.");
            }
            const existing = this.#scopes.get(key);
            if (existing !== undefined) return existing;
            const created = new TerminalCollection({
                projectId: scope.projectId,
                processFactory: this.#processFactory,
                root,
            });
            this.#scopes.set(key, created);
            return created;
        });
    }

    /** Where this folder actually is, according to the catalog that owns it. */
    async #root(ctx: Context, scope: TerminalScope): Promise<string> {
        const project = await this.#projects.get(ctx, scope.projectId);
        if (project === undefined) {
            throw new TerminalError("not_found", "The project was not found.");
        }
        if (scope.workspaceId === undefined) {
            if (project.status === "archived") {
                throw new TerminalError(
                    "conflict",
                    "An archived project cannot open a terminal.",
                );
            }
            return project.repositoryRef;
        }
        const workspace = await this.#workspaces.get(ctx, scope.workspaceId);
        if (workspace === undefined || workspace.projectRef !== scope.projectId) {
            throw new TerminalError("not_found", "The workspace was not found.");
        }
        if (workspace.status !== "ready") {
            throw new TerminalError(
                "conflict",
                "Only a ready workspace can open a terminal.",
            );
        }
        return workspace.path;
    }
}

function assertScope(scope: TerminalScope): void {
    if (!Value.Check(terminalScopeSchema, scope)) {
        throw new TerminalError("invalid", "The terminal project or workspace is invalid.");
    }
}

/** One key per folder. A project and its workspaces are separate collections, as their folders are. */
function scopeKey(scope: TerminalScope): string {
    return JSON.stringify([scope.projectId, scope.workspaceId ?? null]);
}
