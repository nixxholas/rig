import {
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { type Context } from "@steve.kite/stdlib";

import {
    workspaceAgentIdSchema,
    workspaceApplyGitFactsInputSchema,
    workspaceApplyProbeInputSchema,
    workspaceArchiveOptionsSchema,
    workspaceIdSchema,
    workspaceInheritNameInputSchema,
    workspaceMarkFailedInputSchema,
    workspaceMarkReadyInputSchema,
    workspaceOperationIdSchema,
    workspaceRecordInitializationInputSchema,
    workspaceRenameInputSchema,
    workspaceReorderInputSchema,
    workspaceReserveHooksSchema,
    workspaceReserveInputSchema,
    workspaceSetBranchInputSchema,
    workspaceTimestampSchema,
    workspaceSchema,
    type Workspace,
    type WorkspaceApplyGitFactsInput,
    type WorkspaceApplyProbeInput,
    type WorkspaceArchiveOptions,
    type WorkspaceInheritNameInput,
    type WorkspaceMarkFailedInput,
    type WorkspaceMarkReadyInput,
    type WorkspaceMutationOperation,
    type WorkspaceRecordInitializationInput,
    type WorkspaceRenameInput,
    type WorkspaceReorderInput,
    type WorkspaceReserveHooks,
    type WorkspaceReserveInput,
    type WorkspaceSetBranchInput,
} from "./Workspace.js";
import {
    authorizeWorkspaceAccess,
    assertWorkspaceRecord,
} from "./WorkspaceAccess.js";
import {
    workspaceBranchMetadataSchema,
    type WorkspaceBranchMetadata,
} from "./WorkspaceBranchMetadata.js";
import {
    MAX_WORKSPACE_BRANCH_METADATA_DETAIL_PAGE_SIZE,
    workspaceBranchMetadataDetailQuerySchema,
    workspaceBranchMetadataPageSchema,
    type WorkspaceBranchMetadataDetailQuery,
    type WorkspaceBranchMetadataPage,
} from "./WorkspaceBranchMetadataPage.js";
import {
    workspaceContextSchema,
    workspaceEventIdSchema,
    workspaceEventSchema,
    workspaceModuleListenerSchema,
    type WorkspaceModuleListener,
} from "./WorkspaceEvent.js";
import {
    firstBranchMetadataPage,
    firstWorkspaceDetailPage,
    fitPageForModel,
    fitWorkspaceBranchMetadataPage,
    fitWorkspaceDetailPage,
    formatWorkspaceBranchMetadataPage,
    formatWorkspaceDetailPage,
    workspaceBranchMetadataDetailText,
    workspaceDetailText,
    workspaceRow,
} from "./WorkspaceFormat.js";
import { WorkspaceMutations, type WorkspaceEventPayload } from "./WorkspaceMutations.js";
import {
    MAX_WORKSPACE_PAGE_SIZE,
    workspacePageQuerySchema,
    type WorkspacePage,
    type WorkspacePageQuery,
} from "./WorkspacePage.js";
import {
    MAX_WORKSPACE_DETAIL_PAGE_SIZE,
    workspaceDetailPageSchema,
    workspaceDetailQuerySchema,
    type WorkspaceDetailPage,
    type WorkspaceDetailQuery,
    type WorkspaceDetailResult,
} from "./WorkspaceDetailPage.js";
import {
    workspaceTransferInputSchema,
    workspaceTransferResultSchema,
    workspaceTransferStoreResultSchema,
    type WorkspaceProjectTransferInput,
    type WorkspaceSessionTransferInput,
    type WorkspaceTransferInput,
    type WorkspaceTransferResult,
} from "./WorkspaceTransfer.js";
import {
    assertWorkspace,
    assertWorkspaceBranchMetadata,
    assertWorkspaceList,
    assertWorkspacePage,
    createWorkspaceStore,
    workspaceHostSchema,
    workspaceAuthorizationSchema,
    workspaceMigrations,
    type WorkspaceAuthorization,
    type WorkspaceAuthorizationAction,
    type WorkspaceHost,
    type WorkspaceMutationRequest,
    type WorkspaceMutationResult,
    type WorkspaceStore,
    type WorkspaceTransactionChange,
} from "./WorkspaceStore.js";
import { isPromiseLike, requirePromise, safeError } from "./workspaceRuntime.js";
import { archiveWorkspaceTool } from "./tools/archive_workspace.js";
import { createWorkspaceTool } from "./tools/create_workspace.js";
import { getBranchMetadataTool } from "./tools/get_branch_metadata.js";
import { getWorkspaceTool } from "./tools/get_workspace.js";
import { listWorkspacesTool } from "./tools/list_workspaces.js";
import { renameWorkspaceTool } from "./tools/rename_workspace.js";
import { transferWorkspaceTool } from "./tools/transfer_workspace.js";

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_OUTPUT_CHARACTERS = 12_000;

export const workspaceIdFactorySchema = Type.Function(
    [workspaceContextSchema, workspaceAgentIdSchema],
    Type.Union([workspaceIdSchema, Type.Promise(workspaceIdSchema)]),
);
export const workspaceEventIdFactorySchema = Type.Function(
    [workspaceContextSchema, workspaceAgentIdSchema],
    Type.Union([workspaceEventIdSchema, Type.Promise(workspaceEventIdSchema)]),
);
export const workspaceClockSchema = Type.Function(
    [workspaceContextSchema, workspaceAgentIdSchema],
    workspaceTimestampSchema,
);
export const workspacePostCommitErrorSchema = Type.Function(
    [workspaceContextSchema, workspaceEventSchema, Type.Unknown()],
    Type.Union([Type.Void(), Type.Promise(Type.Void())]),
);
/**
 * Told when the host's own Git or filesystem work failed after a durable decision had already been
 * recorded. Archival is never rolled back because cleanup failed, so this is how that failure
 * reaches a log instead of the caller.
 */
export const workspaceHostErrorSchema = Type.Function(
    [
        workspaceContextSchema,
        workspaceIdSchema,
        Type.Union([Type.Literal("archive"), Type.Literal("rename")]),
        Type.String(),
    ],
    Type.Union([Type.Void(), Type.Promise(Type.Void())]),
);
const workspaceMaxPageSizeSchema = Type.Integer({
    minimum: 1,
    maximum: MAX_WORKSPACE_PAGE_SIZE,
});
const workspaceMaxOutputSchema = Type.Integer({
    minimum: 256,
    maximum: 100_000,
});

export const workspaceModuleOptionsSchema = Type.Object(
    {
        enabled: Type.Optional(Type.Boolean()),
        host: Type.Optional(workspaceHostSchema),
        authorization: Type.Optional(workspaceAuthorizationSchema),
        idFactory: Type.Optional(workspaceIdFactorySchema),
        eventIdFactory: Type.Optional(workspaceEventIdFactorySchema),
        clock: Type.Optional(workspaceClockSchema),
        listener: Type.Optional(workspaceModuleListenerSchema),
        maxPageSize: Type.Optional(workspaceMaxPageSizeSchema),
        maxOutputCharacters: Type.Optional(workspaceMaxOutputSchema),
        onPostCommitError: Type.Optional(workspacePostCommitErrorSchema),
        onHostError: Type.Optional(workspaceHostErrorSchema),
        /**
         * The lifetime folder removal runs on: a named context derived from the application root,
         * carrying the agent database. Archival is a durable decision that must be answered at
         * once, so the filesystem work it implies outlives the call that asked for it and cannot
         * belong to that caller's context.
         */
        cleanupContext: Type.Optional(workspaceContextSchema),
    },
    { additionalProperties: false },
);

export type WorkspaceModuleOptions = Static<typeof workspaceModuleOptionsSchema>;

/** What a reservation produced: the workspace, and whether this call is the one that made it. */
export interface WorkspaceReservation {
    readonly created: boolean;
    readonly workspace: Workspace;
}

export class WorkspacesModule implements AgentModule {
    readonly name = "workspaces";
    readonly migrations = workspaceMigrations;

    readonly #store: WorkspaceStore;
    readonly #mutations: WorkspaceMutations;
    readonly #host: WorkspaceHost | undefined;
    readonly #enabled: boolean;
    readonly #authorization: WorkspaceAuthorization | undefined;
    readonly #idFactory: NonNullable<WorkspaceModuleOptions["idFactory"]>;
    readonly #maxPageSize: number;
    readonly #maxOutputCharacters: number;
    readonly #onHostError: WorkspaceModuleOptions["onHostError"];
    readonly #cleanupContext: Context | undefined;
    readonly #cleanupTasks = new Set<Promise<void>>();

    constructor(options: WorkspaceModuleOptions) {
        assertWorkspaceModuleOptions(options);
        if (options.host?.archive !== undefined && options.cleanupContext === undefined) {
            throw new Error(
                "A workspace host that removes folders needs a cleanupContext to remove them on.",
            );
        }
        this.#host = options.host;
        this.#store = createWorkspaceStore({
            ...(options.host === undefined ? {} : { host: options.host }),
        });
        this.#enabled = options.enabled ?? true;
        this.#authorization = options.authorization;
        this.#idFactory =
            options.idFactory ??
            ((_ctx: Context, _agentId: string) => globalThis.crypto.randomUUID());
        this.#maxPageSize = options.maxPageSize ?? DEFAULT_PAGE_SIZE;
        this.#maxOutputCharacters = options.maxOutputCharacters ?? DEFAULT_OUTPUT_CHARACTERS;
        this.#onHostError = options.onHostError;
        this.#cleanupContext = options.cleanupContext;
        this.#mutations = new WorkspaceMutations({
            store: this.#store,
            eventIdFactory:
                options.eventIdFactory ??
                ((_ctx: Context, _agentId: string) => globalThis.crypto.randomUUID()),
            clock: options.clock ?? ((_ctx: Context, _agentId: string) => Date.now()),
            listener: options.listener,
            onPostCommitError: options.onPostCommitError,
        });
    }

    readonly #hooks: AgentModuleHooks = {
        tools: (_ctx: Context, scope: AgentModuleScope): readonly AnyAgentTool[] => {
            this.#assertAgentId(scope.agent.id);
            if (!this.#enabled) return [];
            return [
                createWorkspaceTool(this, scope.agent.id),
                listWorkspacesTool(this, scope.agent.id),
                getWorkspaceTool(this, scope.agent.id),
                renameWorkspaceTool(this, scope.agent.id),
                transferWorkspaceTool(this, scope.agent.id),
                archiveWorkspaceTool(this, scope.agent.id),
                getBranchMetadataTool(this, scope.agent.id),
            ];
        },
    };

    readonly beforeStart = (): AgentModuleHooks => this.#hooks;

    /**
     * Reserves one workspace: a name, folder key, and branch nothing else has taken, recorded
     * before any Git or filesystem work begins.
     *
     * A tool call that is retried after a crash arrives with the same `operationId`, and that ID
     * is the workspace's identity when the caller did not choose one. Two attempts at one create
     * therefore converge on one row rather than producing a second workspace that nobody asked for.
     */
    async reserve(
        ctx: Context,
        agentId: string,
        input: WorkspaceReserveInput,
        hooks: WorkspaceReserveHooks = {},
    ): Promise<WorkspaceReservation> {
        this.#assertEnabled();
        this.#assertAgentId(agentId);
        this.#assertInput(workspaceReserveInputSchema, input, "workspace reservation");
        if (!Value.Check(workspaceReserveHooksSchema, hooks)) {
            throw new Error("Workspace reservation hooks are invalid.");
        }
        const normalized = structuredClone(input);
        const workspaceId =
            normalized.id ??
            normalized.operationId ??
            (await this.#newIdentity(ctx, agentId, workspaceIdSchema));
        const result = await this.#mutateResult(
            ctx,
            agentId,
            "reserve",
            normalized.operationId,
            workspaceId,
            async (txCtx, request) =>
                await this.#store.reserve(
                    txCtx,
                    agentId,
                    {
                        id: workspaceId,
                        ownerAgentId: agentId,
                        projectRef: normalized.projectRef,
                        name: normalized.name,
                        nameConfigured: normalized.nameConfigured ?? false,
                        kind: normalized.kind ?? "git_worktree",
                        ...(normalized.baseRef === undefined
                            ? {}
                            : { baseRef: normalized.baseRef }),
                        ...(normalized.baseCommit === undefined
                            ? {}
                            : { baseCommit: normalized.baseCommit }),
                        ...(normalized.gitCommonDir === undefined
                            ? {}
                            : { gitCommonDir: normalized.gitCommonDir }),
                        ...(normalized.creatorSessionId === undefined
                            ? {}
                            : { creatorSessionId: normalized.creatorSessionId }),
                        ...(normalized.storageKeySeed === undefined
                            ? {}
                            : { storageKeySeed: normalized.storageKeySeed }),
                    },
                    hooks,
                    request,
                ),
            (before, after) =>
                before === undefined
                    ? { type: "workspace_created", agentId, workspace: after }
                    : undefined,
        );
        return { created: result.changed, workspace: result.workspace };
    }

    /** Renames a workspace on a person's behalf, and moves its branch with the name. */
    async rename(ctx: Context, agentId: string, input: WorkspaceRenameInput): Promise<Workspace> {
        this.#assertEnabled();
        this.#assertAgentId(agentId);
        this.#assertInput(workspaceRenameInputSchema, input, "workspace rename");
        const normalized = structuredClone(input);
        let previousBranch: string | undefined;
        const renamed = await this.#mutate(
            ctx,
            agentId,
            "rename",
            normalized.operationId,
            normalized.workspaceId,
            async (txCtx, request) =>
                await this.#store.rename(
                    txCtx,
                    agentId,
                    {
                        workspaceId: normalized.workspaceId,
                        name: normalized.name,
                        ...(normalized.expectedVersion === undefined
                            ? {}
                            : { expectedVersion: normalized.expectedVersion }),
                    },
                    request,
                ),
            (before, after) => {
                if (before === undefined || before.name === after.name) return undefined;
                previousBranch = before.branch;
                return {
                    type: "workspace_renamed",
                    agentId,
                    workspace: after,
                    previousName: before.name,
                };
            },
        );
        if (previousBranch === undefined || previousBranch === renamed.branch) return renamed;
        return await this.#moveHostBranch(ctx, agentId, renamed, previousBranch);
    }

    /**
     * Gives a workspace the name its first chat arrived at. A workspace someone has already named
     * keeps that name: only a placeholder is replaced.
     */
    async inheritName(
        ctx: Context,
        agentId: string,
        input: WorkspaceInheritNameInput,
    ): Promise<Workspace> {
        this.#assertEnabled();
        this.#assertAgentId(agentId);
        this.#assertInput(workspaceInheritNameInputSchema, input, "workspace name inheritance");
        const normalized = structuredClone(input);
        let previousBranch: string | undefined;
        const named = await this.#mutate(
            ctx,
            agentId,
            "inherit_name",
            normalized.operationId,
            normalized.workspaceId,
            async (txCtx, request) =>
                await this.#store.inheritName(
                    txCtx,
                    agentId,
                    { workspaceId: normalized.workspaceId, name: normalized.name },
                    request,
                ),
            (before, after) => {
                if (before === undefined || before.name === after.name) return undefined;
                previousBranch = before.branch;
                return {
                    type: "workspace_renamed",
                    agentId,
                    workspace: after,
                    previousName: before.name,
                };
            },
        );
        if (previousBranch === undefined || previousBranch === named.branch) return named;
        return await this.#moveHostBranch(ctx, agentId, named, previousBranch);
    }

    /** Records the branch a host actually created or renamed to. */
    async setBranch(
        ctx: Context,
        agentId: string,
        input: WorkspaceSetBranchInput,
    ): Promise<Workspace> {
        this.#assertEnabled();
        this.#assertAgentId(agentId);
        this.#assertInput(workspaceSetBranchInputSchema, input, "workspace branch");
        const normalized = structuredClone(input);
        return await this.#mutate(
            ctx,
            agentId,
            "set_branch",
            normalized.operationId,
            normalized.workspaceId,
            async (txCtx, request) =>
                await this.#store.setBranch(
                    txCtx,
                    agentId,
                    { workspaceId: normalized.workspaceId, branch: normalized.branch },
                    request,
                ),
            (_before, after) => ({
                type: "workspace_updated",
                agentId,
                change: "set_branch",
                workspace: after,
            }),
        );
    }

    /** Records the base commit, base ref, and shared Git directory the host resolved. */
    async recordInitialization(
        ctx: Context,
        agentId: string,
        input: WorkspaceRecordInitializationInput,
    ): Promise<Workspace> {
        this.#assertEnabled();
        this.#assertAgentId(agentId);
        this.#assertInput(
            workspaceRecordInitializationInputSchema,
            input,
            "workspace initialization",
        );
        const normalized = structuredClone(input);
        return await this.#mutate(
            ctx,
            agentId,
            "record_initialization",
            normalized.operationId,
            normalized.workspaceId,
            async (txCtx, request) =>
                await this.#store.recordInitialization(
                    txCtx,
                    agentId,
                    { workspaceId: normalized.workspaceId, facts: normalized.facts },
                    request,
                ),
            (_before, after) => ({
                type: "workspace_updated",
                agentId,
                change: "record_initialization",
                workspace: after,
            }),
        );
    }

    /** The workspace is checked out, set up, and ready for someone to work in. */
    async markReady(
        ctx: Context,
        agentId: string,
        input: WorkspaceMarkReadyInput,
    ): Promise<Workspace> {
        this.#assertEnabled();
        this.#assertAgentId(agentId);
        this.#assertInput(workspaceMarkReadyInputSchema, input, "workspace readiness");
        const normalized = structuredClone(input);
        return await this.#mutate(
            ctx,
            agentId,
            "mark_ready",
            normalized.operationId,
            normalized.workspaceId,
            async (txCtx, request) =>
                await this.#store.markReady(
                    txCtx,
                    agentId,
                    { workspaceId: normalized.workspaceId },
                    request,
                ),
            (_before, after) => ({
                type: "workspace_updated",
                agentId,
                change: "mark_ready",
                workspace: after,
            }),
        );
    }

    /** A ready workspace stopped working, with a bounded explanation of why. */
    async markFailed(
        ctx: Context,
        agentId: string,
        input: WorkspaceMarkFailedInput,
    ): Promise<Workspace> {
        this.#assertEnabled();
        this.#assertAgentId(agentId);
        this.#assertInput(workspaceMarkFailedInputSchema, input, "workspace failure");
        const normalized = structuredClone(input);
        return await this.#mutate(
            ctx,
            agentId,
            "mark_failed",
            normalized.operationId,
            normalized.workspaceId,
            async (txCtx, request) =>
                await this.#store.markFailed(
                    txCtx,
                    agentId,
                    { workspaceId: normalized.workspaceId, error: normalized.error },
                    request,
                ),
            (_before, after) => ({
                type: "workspace_updated",
                agentId,
                change: "mark_failed",
                workspace: after,
            }),
        );
    }

    /** Provisioning never finished. The attempt is counted so a retry can be decided later. */
    async markInitializationFailed(
        ctx: Context,
        agentId: string,
        input: WorkspaceMarkFailedInput,
    ): Promise<Workspace> {
        this.#assertEnabled();
        this.#assertAgentId(agentId);
        this.#assertInput(
            workspaceMarkFailedInputSchema,
            input,
            "workspace initialization failure",
        );
        const normalized = structuredClone(input);
        return await this.#mutate(
            ctx,
            agentId,
            "mark_initialization_failed",
            normalized.operationId,
            normalized.workspaceId,
            async (txCtx, request) =>
                await this.#store.markInitializationFailed(
                    txCtx,
                    agentId,
                    { workspaceId: normalized.workspaceId, error: normalized.error },
                    request,
                ),
            (_before, after) => ({
                type: "workspace_updated",
                agentId,
                change: "mark_initialization_failed",
                workspace: after,
            }),
        );
    }

    /** Moves a workspace in the main list, placing it after another one or at the top. */
    async reorder(
        ctx: Context,
        agentId: string,
        input: WorkspaceReorderInput,
    ): Promise<Workspace> {
        this.#assertEnabled();
        this.#assertAgentId(agentId);
        this.#assertInput(workspaceReorderInputSchema, input, "workspace reorder");
        const normalized = structuredClone(input);
        return await this.#mutate(
            ctx,
            agentId,
            "reorder",
            normalized.operationId,
            normalized.workspaceId,
            async (txCtx, request) =>
                await this.#store.reorder(
                    txCtx,
                    agentId,
                    {
                        workspaceId: normalized.workspaceId,
                        afterId: normalized.afterId,
                        ...(normalized.expectedVersion === undefined
                            ? {}
                            : { expectedVersion: normalized.expectedVersion }),
                    },
                    request,
                ),
            (before, after) =>
                before === undefined
                    ? undefined
                    : {
                          type: "workspace_reordered",
                          agentId,
                          workspace: after,
                          previousOrderKey: before.orderKey,
                      },
        );
    }

    /**
     * Archives a workspace: the immediate, irreversible logical decision. It leaves the active
     * list at once and never comes back because cleanup went wrong.
     */
    async beginArchive(
        ctx: Context,
        agentId: string,
        workspaceId: string,
        options: WorkspaceArchiveOptions = {},
    ): Promise<Workspace> {
        this.#assertEnabled();
        this.#assertAgentId(agentId);
        this.#assertId(workspaceId, "workspace");
        this.#assertInput(workspaceArchiveOptionsSchema, options, "workspace archive");
        const normalized = structuredClone(options);
        return await this.#mutate(
            ctx,
            agentId,
            "begin_archive",
            normalized.operationId,
            workspaceId,
            async (txCtx, request) =>
                await this.#store.beginArchive(
                    txCtx,
                    agentId,
                    {
                        workspaceId,
                        ...(normalized.expectedVersion === undefined
                            ? {}
                            : { expectedVersion: normalized.expectedVersion }),
                    },
                    request,
                ),
            (_before, after) => ({
                type: "workspace_updated",
                agentId,
                change: "begin_archive",
                workspace: after,
            }),
        );
    }

    /** Records that the host finished taking the workspace's folder or worktree away. */
    async completeArchive(
        ctx: Context,
        agentId: string,
        workspaceId: string,
        options: WorkspaceArchiveOptions = {},
    ): Promise<Workspace> {
        this.#assertEnabled();
        this.#assertAgentId(agentId);
        this.#assertId(workspaceId, "workspace");
        this.#assertInput(workspaceArchiveOptionsSchema, options, "workspace archive completion");
        const normalized = structuredClone(options);
        return await this.#mutate(
            ctx,
            agentId,
            "complete_archive",
            normalized.operationId,
            workspaceId,
            async (txCtx, request) =>
                await this.#store.completeArchive(txCtx, agentId, { workspaceId }, request),
            (_before, after) => ({ type: "workspace_archived", agentId, workspace: after }),
        );
    }

    /**
     * Archives a workspace and hands its folder to the host to remove.
     *
     * The archival is committed here and returned at once: the workspace has left the active list
     * before this call answers. Removing a worktree can take minutes and can fail, so it runs on
     * the module's cleanup lifetime instead of the caller's, and its outcome arrives later as the
     * `workspace_archived` event or as a reported host error. Archival never fails because
     * cleanup did.
     */
    async archive(
        ctx: Context,
        agentId: string,
        workspaceId: string,
        options: WorkspaceArchiveOptions = {},
    ): Promise<Workspace> {
        const begun = await this.beginArchive(ctx, agentId, workspaceId, options);
        if (begun.status !== "archiving") return begun;
        const cleanup = this.#host?.archive;
        if (cleanup === undefined) return await this.completeArchive(ctx, agentId, workspaceId);
        const lifetime = this.#cleanupContext;
        if (lifetime === undefined) {
            throw new Error(
                "A workspace host that removes folders needs a cleanupContext to remove them on.",
            );
        }
        const operationId =
            options.operationId ??
            (await this.#newIdentity(ctx, agentId, workspaceOperationIdSchema));
        this.#runCleanup(lifetime, async (workerCtx) => {
            try {
                await cleanup(
                    workerCtx,
                    agentId,
                    {
                        workspaceId,
                        path: begun.path,
                        kind: begun.kind,
                        ...(begun.gitCommonDir === undefined
                            ? {}
                            : { gitCommonDir: begun.gitCommonDir }),
                    },
                    { operation: "begin_archive", operationId },
                );
            } catch (error: unknown) {
                await this.#reportHostError(workerCtx, workspaceId, "archive", error);
                return;
            }
            await this.completeArchive(workerCtx, agentId, workspaceId);
        });
        return begun;
    }

    /** Waits for the folder removals this module started. Closing and tests both need it. */
    async whenCleanupSettles(): Promise<void> {
        while (this.#cleanupTasks.size > 0) {
            await Promise.allSettled([...this.#cleanupTasks]);
        }
    }

    /** Persists the Git state the host observed, writing only when something actually changed. */
    async applyGitFacts(
        ctx: Context,
        agentId: string,
        input: WorkspaceApplyGitFactsInput,
    ): Promise<Workspace> {
        this.#assertEnabled();
        this.#assertAgentId(agentId);
        this.#assertInput(workspaceApplyGitFactsInputSchema, input, "workspace Git facts");
        const normalized = structuredClone(input);
        return await this.#mutate(
            ctx,
            agentId,
            "apply_git_facts",
            normalized.operationId,
            normalized.workspaceId,
            async (txCtx, request) =>
                await this.#store.applyGitFacts(
                    txCtx,
                    agentId,
                    { workspaceId: normalized.workspaceId, facts: normalized.facts },
                    request,
                ),
            (_before, after) => ({
                type: "workspace_updated",
                agentId,
                change: "apply_git_facts",
                workspace: after,
            }),
        );
    }

    /** The same, plus whether the folder was still there when the host looked. */
    async applyProbe(
        ctx: Context,
        agentId: string,
        input: WorkspaceApplyProbeInput,
    ): Promise<Workspace> {
        this.#assertEnabled();
        this.#assertAgentId(agentId);
        this.#assertInput(workspaceApplyProbeInputSchema, input, "workspace probe");
        const normalized = structuredClone(input);
        return await this.#mutate(
            ctx,
            agentId,
            "apply_probe",
            normalized.operationId,
            normalized.workspaceId,
            async (txCtx, request) =>
                await this.#store.applyProbe(
                    txCtx,
                    agentId,
                    {
                        workspaceId: normalized.workspaceId,
                        presence: normalized.presence,
                        facts: normalized.facts,
                    },
                    request,
                ),
            (_before, after) => ({
                type: "workspace_updated",
                agentId,
                change: "apply_probe",
                workspace: after,
            }),
        );
    }

    /**
     * The workspaces someone can still work in. Archived rows are history: they are only listed
     * when a caller asks for them by name, so a list nobody qualified never shows a folder that
     * is already gone.
     */
    async listPage(
        ctx: Context,
        agentId: string,
        query: WorkspacePageQuery = {},
    ): Promise<WorkspacePage> {
        this.#assertEnabled();
        this.#assertAgentId(agentId);
        this.#assertInput(workspacePageQuerySchema, query, "workspace page query");
        const limit = query.limit ?? this.#maxPageSize;
        if (limit > this.#maxPageSize) {
            throw new Error(`Workspace page limit cannot exceed ${String(this.#maxPageSize)}.`);
        }
        const normalized = {
            ...structuredClone(query),
            includeArchived: query.includeArchived === true,
            limit,
        };
        const raw = await requirePromise(
            this.#store.list(ctx, agentId, normalized),
            "Workspace store list",
        );
        assertWorkspacePage(raw);
        this.#assertPage(raw, normalized.cursor ?? 0, limit);
        for (const workspace of raw.workspaces) {
            assertWorkspaceRecord(workspace);
            if (
                normalized.projectRef !== undefined &&
                workspace.projectRef !== normalized.projectRef
            ) {
                throw new Error("Workspace page returned a row outside the requested project.");
            }
            if (
                !normalized.includeArchived &&
                (workspace.status === "archived" || workspace.status === "archiving")
            ) {
                throw new Error("Workspace page returned an archived row without includeArchived.");
            }
            await this.#authorize(ctx, agentId, workspace.ownerAgentId, "list");
        }
        return structuredClone(fitPageForModel(raw, this.#maxOutputCharacters));
    }

    async list(
        ctx: Context,
        agentId: string,
        query: WorkspacePageQuery = {},
    ): Promise<Workspace[]> {
        this.#assertEnabled();
        return (await this.listPage(ctx, agentId, query)).workspaces;
    }

    async get(ctx: Context, agentId: string, workspaceId: string): Promise<Workspace | undefined> {
        this.#assertEnabled();
        this.#assertAgentId(agentId);
        this.#assertId(workspaceId, "workspace");
        const raw = await requirePromise(
            this.#store.get(ctx, agentId, workspaceId),
            "Workspace store get",
        );
        if (raw === undefined) return undefined;
        assertWorkspace(raw);
        assertWorkspaceRecord(raw);
        if (raw.id !== workspaceId) {
            throw new Error("Workspace store returned a different workspace identity.");
        }
        await this.#authorize(ctx, agentId, raw.ownerAgentId, "get");
        return structuredClone(raw);
    }

    /** Resolves a folder to the workspace that lives in it, for a host resolving a cwd. */
    async getByPath(ctx: Context, agentId: string, path: string): Promise<Workspace | undefined> {
        this.#assertEnabled();
        this.#assertAgentId(agentId);
        if (typeof path !== "string" || path.length === 0) {
            throw new Error("Workspace path is invalid.");
        }
        const raw = await requirePromise(
            this.#store.getByPath(ctx, agentId, path),
            "Workspace store get by path",
        );
        if (raw === undefined) return undefined;
        assertWorkspace(raw);
        assertWorkspaceRecord(raw);
        if (raw.path !== path) {
            throw new Error("Workspace store returned a workspace with a different path.");
        }
        await this.#authorize(ctx, agentId, raw.ownerAgentId, "get");
        return structuredClone(raw);
    }

    /** Read one workspace with a bounded, cursor-addressable detail stream. */
    async getPage(
        ctx: Context,
        agentId: string,
        workspaceId: string,
        query: WorkspaceDetailQuery = {},
    ): Promise<WorkspaceDetailPage> {
        this.#assertEnabled();
        this.#assertAgentId(agentId);
        this.#assertId(workspaceId, "workspace");
        if (!Value.Check(workspaceDetailQuerySchema, query)) {
            throw new Error("Workspace detail query is invalid.");
        }
        const workspace = await this.get(ctx, agentId, workspaceId);
        if (workspace === undefined) return { workspace: null };
        const detail = workspaceDetailText(workspace);
        const cursor = query.cursor ?? 0;
        const limit = query.limit ?? MAX_WORKSPACE_DETAIL_PAGE_SIZE;
        if (cursor > detail.length) {
            throw new Error("Workspace detail cursor is past the available detail.");
        }
        return fitWorkspaceDetailPage(
            {
                workspace,
                detail: detail.slice(cursor, cursor + limit),
                cursor,
                total: detail.length,
                ...(cursor + limit < detail.length ? { nextCursor: cursor + limit } : {}),
            },
            this.#maxOutputCharacters,
        );
    }

    async transfer(
        ctx: Context,
        agentId: string,
        input: WorkspaceTransferInput,
    ): Promise<WorkspaceTransferResult> {
        this.#assertEnabled();
        this.#assertAgentId(agentId);
        this.#assertInput(workspaceTransferInputSchema, input, "workspace transfer");
        const normalized = structuredClone(input);
        const request = stripOperationId(normalized);
        const operationId =
            normalized.operationId ??
            (await this.#newIdentity(ctx, agentId, workspaceOperationIdSchema));
        const mutationRequest: WorkspaceMutationRequest = { operation: "transfer", operationId };
        const subjectId =
            "workspaceId" in request ? request.workspaceId : request.targetWorkspaceId;

        const change = await this.#mutations.runTransaction(ctx, async (txCtx) => {
            const before = await this.#mutations.getRequired(txCtx, agentId, subjectId);
            if ("workspaceId" in request) this.#assertOwner(agentId, before);
            else await this.#authorize(txCtx, agentId, before.ownerAgentId, "transfer");

            const raw = await requirePromise(
                this.#store.transfer(txCtx, agentId, structuredClone(request), mutationRequest),
                "Workspace store transfer",
            );
            const result = normalizeTransferStoreResult(raw, agentId, operationId);
            if (result.agentId !== agentId || result.operationId !== operationId) {
                throw new Error("Workspace transfer result identity does not match the request.");
            }
            assertTransferRequestResult(result, request);
            const after = await this.#mutations.getRequired(txCtx, agentId, subjectId);
            if ("workspaceId" in request && after.projectRef !== request.targetProjectRef) {
                throw new Error(
                    "Workspace project transfer did not reach the requested project reference.",
                );
            }
            if (!result.changed) return { result };
            const event =
                result.state === "scheduled"
                    ? await this.#mutations.newEvent(txCtx, agentId, {
                          type: "workspace_transfer_scheduled",
                          agentId,
                          targetWorkspaceId: result.targetWorkspaceId,
                      })
                    : await this.#mutations.newEvent(txCtx, agentId, {
                          type: "workspace_transferred",
                          agentId,
                          workspace: after,
                          ...("workspaceId" in request
                              ? { previousProjectRef: before.projectRef }
                              : {}),
                      });
            await this.#mutations.observe(txCtx, event);
            return { result, event };
        });
        return structuredClone(requireTransferFromResult(change.result));
    }

    async branchMetadata(
        ctx: Context,
        agentId: string,
        workspaceId: string,
    ): Promise<WorkspaceBranchMetadata> {
        this.#assertEnabled();
        this.#assertAgentId(agentId);
        this.#assertId(workspaceId, "workspace");
        const workspace = await this.#mutations.getRequired(ctx, agentId, workspaceId);
        await this.#authorize(ctx, agentId, workspace.ownerAgentId, "branch_metadata");
        const raw = await requirePromise(
            this.#store.branchMetadata(ctx, agentId, workspaceId),
            "Workspace store branch metadata",
        );
        assertWorkspaceBranchMetadata(raw);
        if (raw.workspaceId !== workspaceId) {
            throw new Error("Workspace branch metadata belongs to another workspace.");
        }
        return structuredClone(raw);
    }

    /** Read branch metadata with a bounded, cursor-addressable detail stream. */
    async branchMetadataPage(
        ctx: Context,
        agentId: string,
        workspaceId: string,
        query: WorkspaceBranchMetadataDetailQuery = {},
    ): Promise<WorkspaceBranchMetadataPage> {
        this.#assertEnabled();
        this.#assertAgentId(agentId);
        this.#assertId(workspaceId, "workspace");
        if (!Value.Check(workspaceBranchMetadataDetailQuerySchema, query)) {
            throw new Error("Workspace branch metadata detail query is invalid.");
        }
        const metadata = await this.branchMetadata(ctx, agentId, workspaceId);
        const detail = workspaceBranchMetadataDetailText(metadata);
        const cursor = query.cursor ?? 0;
        const limit = query.limit ?? MAX_WORKSPACE_BRANCH_METADATA_DETAIL_PAGE_SIZE;
        if (cursor > detail.length) {
            throw new Error("Workspace branch metadata cursor is past the available detail.");
        }
        return fitWorkspaceBranchMetadataPage(
            {
                ...metadata,
                detail: detail.slice(cursor, cursor + limit),
                cursor,
                total: detail.length,
                ...(cursor + limit < detail.length ? { nextCursor: cursor + limit } : {}),
            },
            this.#maxOutputCharacters,
        );
    }

    /** Bounded rows are intentionally compact; get_workspace is the detail path. */
    formatForModel(workspaces: readonly Workspace[]): string {
        assertWorkspaceList(workspaces);
        if (workspaces.length === 0) return "No workspaces.";
        const rows = workspaces.map(workspaceRow);
        const output = rows.join("\n");
        if (output.length <= this.#maxOutputCharacters) return output;
        const visible: string[] = [];
        let size = 0;
        for (const row of rows) {
            const next = size + row.length + (visible.length === 0 ? 0 : 1);
            if (next > this.#maxOutputCharacters) break;
            visible.push(row);
            size = next;
        }
        if (visible.length === 0) {
            throw new Error("Workspace model output cannot fit a complete identity.");
        }
        return visible.join("\n");
    }

    /** Render one complete workspace detail page without silently dropping fields. */
    formatDetailPageForModel(page: WorkspaceDetailPage | Workspace): string {
        const detailPage = Value.Check(workspaceDetailPageSchema, page)
            ? page
            : Value.Check(workspaceSchema, page)
              ? firstWorkspaceDetailPage(page, this.#maxOutputCharacters)
              : undefined;
        if (detailPage === undefined) {
            throw new Error("Cannot format an invalid workspace detail page.");
        }
        if (detailPage.workspace === null) return "That workspace does not exist.";
        const output = formatWorkspaceDetailPage(detailPage, this.#maxOutputCharacters);
        if (output.length > this.#maxOutputCharacters) {
            throw new Error("Workspace detail page exceeds its model-output bound.");
        }
        return output;
    }

    /** Render one bounded mutation result, retaining a cursor when detail needs multiple calls. */
    formatWorkspaceOperationForModel(label: string, workspace: Workspace): string {
        assertWorkspace(workspace);
        const prefix = `${label}\n`;
        if (prefix.length >= this.#maxOutputCharacters) {
            throw new Error("Workspace operation label exceeds the model-output bound.");
        }
        const budget = this.#maxOutputCharacters - prefix.length;
        const output = `${prefix}${formatWorkspaceDetailPage(
            firstWorkspaceDetailPage(workspace, budget),
            budget,
        )}`;
        if (output.length > this.#maxOutputCharacters) {
            throw new Error("Workspace operation output exceeds its model-output bound.");
        }
        return output;
    }

    formatWorkspaceForModel(workspace: Workspace): string {
        return this.formatWorkspaceOperationForModel("Workspace:", workspace);
    }

    /** Render one branch metadata detail page without silently truncating Git values. */
    formatBranchMetadataDetailPageForModel(
        page: WorkspaceBranchMetadataPage | WorkspaceBranchMetadata,
    ): string {
        const detailPage = Value.Check(workspaceBranchMetadataPageSchema, page)
            ? page
            : Value.Check(workspaceBranchMetadataSchema, page)
              ? fitWorkspaceBranchMetadataPage(
                    firstBranchMetadataPage(page),
                    this.#maxOutputCharacters,
                )
              : undefined;
        if (detailPage === undefined) {
            throw new Error("Cannot format invalid workspace branch metadata detail.");
        }
        const output = formatWorkspaceBranchMetadataPage(detailPage, this.#maxOutputCharacters);
        if (output.length > this.#maxOutputCharacters) {
            throw new Error("Workspace branch metadata detail exceeds its model-output bound.");
        }
        return output;
    }

    formatBranchMetadataForModel(
        page: WorkspaceBranchMetadataPage | WorkspaceBranchMetadata,
    ): string {
        return this.formatBranchMetadataDetailPageForModel(page);
    }

    formatPageForModel(page: WorkspacePage): string {
        assertWorkspacePage(page);
        const visiblePage = fitPageForModel(page, this.#maxOutputCharacters);
        const rows = visiblePage.workspaces.map(workspaceRow);
        const continuation =
            visiblePage.nextCursor === undefined
                ? undefined
                : `More workspaces at cursor ${String(visiblePage.nextCursor)}.`;
        let output = rows.length === 0 ? "No workspaces." : rows.join("\n");
        if (continuation !== undefined) {
            const withContinuation = `${output}\n${continuation}`;
            if (withContinuation.length <= this.#maxOutputCharacters) output = withContinuation;
        }
        return output;
    }

    /** `#mutateResult` for the callers that only care about the row it produced. */
    async #mutate(
        ctx: Context,
        agentId: string,
        operation: WorkspaceMutationOperation,
        requestedOperationId: string | undefined,
        workspaceId: string,
        run: (
            txCtx: Context,
            request: WorkspaceMutationRequest,
        ) => Promise<WorkspaceMutationResult>,
        describe: (
            before: Workspace | undefined,
            after: Workspace,
        ) => WorkspaceEventPayload | undefined,
    ): Promise<Workspace> {
        return (
            await this.#mutateResult(
                ctx,
                agentId,
                operation,
                requestedOperationId,
                workspaceId,
                run,
                describe,
            )
        ).workspace;
    }

    async #mutateResult(
        ctx: Context,
        agentId: string,
        operation: WorkspaceMutationOperation,
        requestedOperationId: string | undefined,
        workspaceId: string,
        run: (
            txCtx: Context,
            request: WorkspaceMutationRequest,
        ) => Promise<WorkspaceMutationResult>,
        describe: (
            before: Workspace | undefined,
            after: Workspace,
        ) => WorkspaceEventPayload | undefined,
    ): Promise<WorkspaceMutationResult> {
        const operationId =
            requestedOperationId ??
            (await this.#newIdentity(ctx, agentId, workspaceOperationIdSchema));
        return await this.#mutations.runResult(
            ctx,
            agentId,
            operation,
            operationId,
            workspaceId,
            run,
            describe,
        );
    }

    /**
     * Asks the host to move the Git branch after the name has already been recorded, then records
     * whichever branch Git ended up on. A refusal leaves the previous branch on the record rather
     * than claiming a branch that does not exist.
     */
    async #moveHostBranch(
        ctx: Context,
        agentId: string,
        workspace: Workspace,
        previousBranch: string,
    ): Promise<Workspace> {
        const move = this.#host?.renameBranch;
        if (move === undefined) return workspace;
        const operationId = await this.#newIdentity(ctx, agentId, workspaceOperationIdSchema);
        let branch: string;
        try {
            branch =
                (await move(
                    ctx,
                    agentId,
                    {
                        workspaceId: workspace.id,
                        path: workspace.path,
                        kind: workspace.kind,
                        name: workspace.name,
                        branch: workspace.branch,
                        previousBranch,
                    },
                    { operation: "rename", operationId },
                )) ?? workspace.branch;
        } catch (error: unknown) {
            await this.#reportHostError(ctx, workspace.id, "rename", error);
            branch = previousBranch;
        }
        if (branch === workspace.branch) return workspace;
        return await this.setBranch(ctx, agentId, { workspaceId: workspace.id, branch });
    }

    /**
     * Starts folder removal on the module's own lifetime. The caller's context is deliberately not
     * used: an archive that has already been committed must not be tied to the request that asked
     * for it, and a failure here cannot reach that caller as an error.
     */
    #runCleanup(lifetime: Context, work: (ctx: Context) => Promise<void>): void {
        const task = work(lifetime)
            .catch(() => undefined)
            .finally(() => {
                this.#cleanupTasks.delete(task);
            });
        this.#cleanupTasks.add(task);
    }

    async #reportHostError(
        ctx: Context,
        workspaceId: string,
        operation: "archive" | "rename",
        error: unknown,
    ): Promise<void> {
        try {
            await this.#onHostError?.(ctx, workspaceId, operation, safeError(error));
        } catch {
            // Reporting is advisory once the durable decision has already been recorded.
        }
    }

    #assertEnabled(): void {
        if (!this.#enabled) {
            throw new Error("Workspaces are disabled by configuration.");
        }
    }

    async #newIdentity(
        ctx: Context,
        agentId: string,
        schema: typeof workspaceIdSchema | typeof workspaceOperationIdSchema,
    ): Promise<string> {
        const raw = this.#idFactory(ctx, agentId);
        const value = isPromiseLike(raw) ? await raw : raw;
        if (!Value.Check(schema, value)) {
            throw new Error("Workspace identity factory returned an invalid identity.");
        }
        return value;
    }

    async #authorize(
        ctx: Context,
        actingAgentId: string,
        ownerAgentId: string,
        action: WorkspaceAuthorizationAction,
    ): Promise<void> {
        await authorizeWorkspaceAccess(
            ctx,
            this.#authorization,
            actingAgentId,
            ownerAgentId,
            action,
        );
    }

    #assertOwner(agentId: string, workspace: Workspace): void {
        if (workspace.ownerAgentId !== agentId) {
            throw new Error(`Agent "${agentId}" is not the owner of workspace "${workspace.id}".`);
        }
    }

    #assertAgentId(agentId: string): void {
        if (!Value.Check(workspaceAgentIdSchema, agentId)) {
            throw new Error("Workspace agent ID is invalid.");
        }
    }

    #assertId(id: string, label: string): void {
        if (!Value.Check(workspaceIdSchema, id)) {
            throw new Error(`Workspace ${label} ID is invalid.`);
        }
    }

    #assertInput<T>(
        schema: Parameters<typeof Value.Check>[0],
        value: unknown,
        label: string,
    ): asserts value is T {
        if (!Value.Check(schema, value)) {
            throw new Error(`Workspace ${label} input is invalid.`);
        }
    }

    #assertPage(page: WorkspacePage, cursor: number, limit: number): void {
        if (page.workspaces.length > limit) {
            throw new Error("Workspace store returned more records than requested.");
        }
        if (page.cursor !== cursor) {
            throw new Error("Workspace page did not answer the requested cursor.");
        }
        const seen = new Set<string>();
        for (const workspace of page.workspaces) {
            if (seen.has(workspace.id)) {
                throw new Error("Workspace page repeated a workspace identity.");
            }
            seen.add(workspace.id);
        }
        if (page.nextCursor === undefined) return;
        if (page.workspaces.length === 0) {
            throw new Error("Workspace page cannot advance an empty page.");
        }
        if (page.nextCursor !== cursor + page.workspaces.length) {
            throw new Error("Workspace page cursor must advance exactly by visible records.");
        }
    }
}

export function assertWorkspaceModuleOptions(
    value: unknown,
): asserts value is WorkspaceModuleOptions {
    if (!Value.Check(workspaceModuleOptionsSchema, value)) {
        throw new Error("Workspace module options are invalid.");
    }
}

function stripOperationId(
    input: WorkspaceTransferInput,
): WorkspaceSessionTransferInput | WorkspaceProjectTransferInput {
    if ("targetWorkspaceId" in input) {
        return { targetWorkspaceId: input.targetWorkspaceId };
    }
    return { workspaceId: input.workspaceId, targetProjectRef: input.targetProjectRef };
}

function assertTransferRequestResult(
    result: WorkspaceTransferResult,
    request: WorkspaceSessionTransferInput | WorkspaceProjectTransferInput,
): void {
    if ("targetWorkspaceId" in request) {
        if (
            result.state === "scheduled" &&
            result.targetWorkspaceId !== request.targetWorkspaceId
        ) {
            throw new Error("Workspace scheduled transfer target does not match the request.");
        }
        if (result.state === "transferred" && result.workspace.id !== request.targetWorkspaceId) {
            throw new Error(
                "Workspace session transfer result does not match the requested workspace.",
            );
        }
        return;
    }
    if (result.state !== "transferred") {
        throw new Error("Workspace project transfer must return a transferred result.");
    }
    if (result.workspace.id !== request.workspaceId) {
        throw new Error("Workspace project transfer changed the workspace identity.");
    }
    if (result.workspace.projectRef !== request.targetProjectRef) {
        throw new Error(
            "Workspace project transfer result does not match the requested project reference.",
        );
    }
}

function normalizeTransferStoreResult(
    raw: Static<typeof workspaceTransferStoreResultSchema>,
    agentId: string,
    operationId: string,
): WorkspaceTransferResult {
    if (Value.Check(workspaceTransferResultSchema, raw)) return structuredClone(raw);
    assertWorkspace(raw);
    assertWorkspaceRecord(raw);
    return {
        agentId,
        operationId,
        changed: true,
        state: "transferred",
        targetWorkspaceId: raw.id,
        workspace: {
            id: raw.id,
            projectRef: raw.projectRef,
            ownerAgentId: raw.ownerAgentId,
            path: raw.path,
        },
    };
}

function requireTransferFromResult(
    result: WorkspaceTransactionChange["result"],
): WorkspaceTransferResult {
    if (!Value.Check(workspaceTransferResultSchema, result)) {
        throw new Error("Workspace transfer did not return a valid transfer result.");
    }
    return result;
}
