import { Value } from "@sinclair/typebox/value";
import { afterCommit, type Context } from "@steve.kite/stdlib";

import { projectEventIdSchema, projectTimestampSchema, type Project } from "./Project.js";
import { authorizeProjectAccess } from "./ProjectAccess.js";
import {
    projectEventSchema,
    type ProjectEvent,
    type ProjectModuleListener,
} from "./ProjectEvent.js";
import { assertProject } from "./ProjectRow.js";
import { type ProjectSettings } from "./ProjectSettings.js";
import {
    assertProjectStoreMutationResult,
    type ProjectAuthorization,
    type ProjectAuthorizationAction,
    type ProjectStore,
    type ProjectStoreMutationResult,
} from "./ProjectStore.js";
import {
    assertProjectRecord,
    assertProjectSettings,
    assertProjectTransition,
    sameJson,
} from "./ProjectTransition.js";
import {
    deepFreeze,
    isDeepFrozen,
    isPromiseLike,
    requirePromise,
    safeError,
} from "./projectRuntime.js";

/** Distributes over the event union, so each event keeps its own fields. */
export type ProjectEventPayload = ProjectEvent extends infer TEvent
    ? TEvent extends ProjectEvent
        ? Omit<TEvent, "eventId" | "at">
        : never
    : never;

export type ProjectMutationSpec<Result extends ProjectStoreMutationResult> = {
    readonly action: ProjectAuthorizationAction;
    /** Reads the project this operation may already have, by folder rather than by ID. */
    readonly beforeByPath?: string;
    readonly changeable: readonly (keyof Project)[];
    readonly event: (after: Project, before: Project | undefined) => ProjectEventPayload;
    readonly projectId?: string;
    readonly run: (txCtx: Context, before: Project | undefined) => Promise<Result>;
};

export interface ProjectMutationsOptions {
    readonly store: ProjectStore;
    readonly authorization: ProjectAuthorization | undefined;
    readonly eventIdFactory: (ctx: Context, agentId: string) => string | Promise<string>;
    readonly clock: (ctx: Context, agentId: string) => number;
    readonly listener: ProjectModuleListener | undefined;
    readonly onPostCommitError:
        | ((ctx: Context, event: ProjectEvent, error: unknown) => void | Promise<void>)
        | undefined;
}

/**
 * The path every durable project change takes, and the reads it is decided from.
 *
 * A mutation runs in one transaction: the row is read, the acting agent is authorized against the
 * row that owns it, the store decides, and the answer is checked against what is actually stored
 * before anything is told about it. One event describes one change, the transactional observer sees
 * it inside that transaction, and the post-commit observer only after the change is durable. An
 * observer that fails cannot undo a committed change.
 */
export class ProjectMutations {
    readonly #store: ProjectStore;
    readonly #authorization: ProjectAuthorization | undefined;
    readonly #eventIdFactory: ProjectMutationsOptions["eventIdFactory"];
    readonly #clock: ProjectMutationsOptions["clock"];
    readonly #listeners: ProjectModuleListener[] = [];
    readonly #onPostCommitError: ProjectMutationsOptions["onPostCommitError"];

    constructor(options: ProjectMutationsOptions) {
        this.#store = options.store;
        this.#authorization = options.authorization;
        this.#eventIdFactory = options.eventIdFactory;
        this.#clock = options.clock;
        if (options.listener !== undefined) this.#listeners.push(options.listener);
        this.#onPostCommitError = options.onPostCommitError;
    }

    /**
     * Adds another observer of the catalog. Another module that has to react to a project change —
     * the workspaces catalog archiving what was cut from an archived project, for instance — asks
     * for its own place in the fan-out rather than replacing the host's listener.
     */
    addListener(listener: ProjectModuleListener): void {
        this.#listeners.push(listener);
    }

    /**
     * Runs one durable catalog write: it reads the project the operation names,
     * authorizes the acting agent, checks the store's answer against the row
     * that is actually stored, and emits one event when something changed.
     */
    async run<Result extends ProjectStoreMutationResult>(
        ctx: Context,
        agentId: string,
        spec: ProjectMutationSpec<Result>,
    ): Promise<Result> {
        return await ctx.inTx(async (txCtx) => {
            const before =
                spec.projectId !== undefined
                    ? await this.getRequired(txCtx, agentId, spec.projectId)
                    : spec.beforeByPath === undefined
                      ? undefined
                      : await this.findByPath(txCtx, agentId, spec.beforeByPath);
            if (before !== undefined) {
                await this.authorize(txCtx, agentId, before.ownerAgentId, spec.action);
            }
            const raw = await spec.run(txCtx, before);
            assertProjectStoreMutationResult(raw);
            if (raw.agentId !== agentId) {
                throw new Error("A project mutation result names a different agent.");
            }
            if (!("project" in raw)) {
                throw new Error("A project mutation did not return a project.");
            }
            const after = await this.getRequired(txCtx, agentId, raw.project.id);
            if (!sameJson(after, raw.project)) {
                throw new Error("A project mutation result does not match what was stored.");
            }
            if (before === undefined) {
                assertProjectRecord(after);
                if (!raw.changed) {
                    throw new Error("A new project must be reported as a change.");
                }
            } else {
                if (after.id !== before.id) {
                    throw new Error("A project mutation changed the identity of the project.");
                }
                assertProjectTransition(before, after, spec.changeable);
                if (raw.changed !== !sameJson(before, after)) {
                    throw new Error("A project mutation result reports the wrong change.");
                }
            }
            if (raw.changed) {
                await this.observe(
                    txCtx,
                    await this.newEvent(txCtx, agentId, spec.event(after, before)),
                    ctx,
                );
            }
            return structuredClone(raw);
        });
    }

    async authorize(
        ctx: Context,
        actingAgentId: string,
        ownerAgentId: string,
        action: ProjectAuthorizationAction,
    ): Promise<void> {
        await authorizeProjectAccess(ctx, this.#authorization, actingAgentId, ownerAgentId, action);
    }

    async getOptional(
        ctx: Context,
        agentId: string,
        projectId: string,
    ): Promise<Project | undefined> {
        const raw = await requirePromise(
            this.#store.get(ctx, agentId, projectId),
            "Project store get",
        );
        if (raw === undefined) return undefined;
        assertProject(raw);
        assertProjectRecord(raw);
        if (raw.id !== projectId) {
            throw new Error("The project store returned a different project.");
        }
        return structuredClone(raw);
    }

    async getRequired(ctx: Context, agentId: string, projectId: string): Promise<Project> {
        const project = await this.getOptional(ctx, agentId, projectId);
        if (project === undefined) throw new Error(`Project "${projectId}" was not found.`);
        return project;
    }

    async findByPath(
        ctx: Context,
        agentId: string,
        repositoryRef: string,
    ): Promise<Project | undefined> {
        const raw = await requirePromise(
            this.#store.findByPath(ctx, agentId, repositoryRef),
            "Project store find by folder",
        );
        if (raw === undefined) return undefined;
        assertProject(raw);
        assertProjectRecord(raw);
        if (raw.repositoryRef !== repositoryRef) {
            throw new Error("The project store returned a different folder.");
        }
        return structuredClone(raw);
    }

    async readSettings(ctx: Context, agentId: string, projectId: string): Promise<ProjectSettings> {
        const raw = await requirePromise(
            this.#store.readSettings(ctx, agentId, projectId),
            "Project store read settings",
        );
        assertProjectSettings(raw);
        return structuredClone(raw);
    }

    async newEvent(
        ctx: Context,
        agentId: string,
        payload: ProjectEventPayload,
    ): Promise<ProjectEvent> {
        const rawId = this.#eventIdFactory(ctx, agentId);
        const eventId = isPromiseLike(rawId) ? await rawId : rawId;
        if (!Value.Check(projectEventIdSchema, eventId)) {
            throw new Error("The project event ID factory returned an invalid ID.");
        }
        const at = this.#clock(ctx, agentId);
        if (!Value.Check(projectTimestampSchema, at)) {
            throw new Error("The project clock must return a non-negative integer.");
        }
        const event = { ...payload, eventId, at };
        if (!Value.Check(projectEventSchema, event)) {
            throw new Error("The project module created an invalid event.");
        }
        return deepFreeze(structuredClone(event)) as ProjectEvent;
    }

    /**
     * Publishes one event: transactionally first, then again once the change is durable.
     *
     * `publishCtx` is the context the caller handed the module. Registering the post-commit
     * callback there is what makes an enclosing transaction the boundary: an event belonging to
     * somebody else's larger write is delivered when that write commits, not when this one does.
     */
    async observe(ctx: Context, event: ProjectEvent, publishCtx: Context = ctx): Promise<void> {
        if (!Value.Check(projectEventSchema, event) || !isDeepFrozen(event)) {
            throw new Error("The project module created an invalid unfrozen event.");
        }
        for (const listener of this.#listeners) {
            const transactional = listener.onEventTransactional;
            if (transactional !== undefined) await transactional.call(listener, ctx, event);
        }
        afterCommit(publishCtx, (postCommitCtx) => this.#notifyPostCommit(postCommitCtx, event));
    }

    async #notifyPostCommit(ctx: Context, event: ProjectEvent): Promise<void> {
        for (const listener of this.#listeners) {
            const notify = listener.onEvent;
            if (notify === undefined) continue;
            try {
                await notify.call(listener, ctx, event);
            } catch (error: unknown) {
                try {
                    await this.#onPostCommitError?.(ctx, event, safeError(error));
                } catch {
                    // Observer reporting is advisory after durable state has settled.
                }
            }
        }
    }
}
