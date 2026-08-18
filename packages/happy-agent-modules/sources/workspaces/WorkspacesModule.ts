import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AgentSystemRef,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { createId } from "@paralleldrive/cuid2";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
    mapAsyncLock,
    type Context,
    type MapAsyncLock,
    type RootContext,
} from "@steve.kite/stdlib";

import { createGitWorktree } from "../git/createGitWorktree.js";
import type { GitCommandRunner } from "../git/GitCommandRunner.js";
import { isGitWorktreeAt } from "../git/isGitWorktreeAt.js";
import { normalizeFuturePath } from "../git/normalizeFuturePath.js";
import { normalizeProjectCwd } from "../git/normalizeProjectCwd.js";
import {
    prepareWorkspaceTransfer,
    WorkspaceTransferTargetRestoreError,
    type PreparedWorkspaceTransfer,
} from "../git/prepareWorkspaceTransfer.js";
import { probeGitRepository } from "../git/probeGitRepository.js";
import { readGitCommonDir } from "../git/readGitCommonDir.js";
import { readGitTopLevel } from "../git/readGitTopLevel.js";
import { renameGitBranch } from "../git/renameGitBranch.js";
import { resolveWorkspaceBase } from "../git/resolveWorkspaceBase.js";
import { directGitCommandRunner } from "../git/runGitCommand.js";
import type { GitRepositoryFacts } from "../git/types.js";
import { projectGitFactsFrom } from "../projects/projectGitFacts.js";
import {
    clientChosenId,
    requestedBaseRef,
    validateProjectName,
} from "../projects/impl/projectNames.js";
import { projectStorageKey } from "../projects/projectIdentity.js";
import { ProjectRegistrationError } from "../projects/ProjectRegistrationError.js";
import type { Project } from "../projects/Project.js";
import type { ProjectsModule } from "../projects/ProjectsModule.js";

import { copyProjectFolder } from "./impl/copyProjectFolder.js";

import { getManagedWorkspacesDirectory } from "./impl/getManagedWorkspacesDirectory.js";
import {
    DEFAULT_WORKSPACE_FOLDER_SETTINGS,
    loadWorkspaceFolderSettings,
    type WorkspaceFolderSettings,
} from "./impl/loadWorkspaceFolderSettings.js";
import { removeWorkspaceDirectory } from "./impl/removeWorkspaceDirectory.js";
import { runWorkspaceSetupCommands } from "./impl/runWorkspaceSetupCommands.js";
import { syncWorkspaceFiles } from "./impl/syncWorkspaceFiles.js";
import { watchWorkspaceSyncPaths } from "./impl/watchWorkspaceSyncPaths.js";
import {
    gitBranchExists,
    workspaceGitRefSnapshot,
    workspaceStorageKeyExists,
} from "./impl/workspaceGitRefSnapshot.js";
import {
    workspaceEnvironmentSchema,
    workspaceFolderSettingsOptionSchema,
    workspaceGitRunnerSchema,
    workspaceProjectsModuleSchema,
    workspaceRootContextSchema,
    type CreateWorkspaceRequest,
    type WorkspaceCreatorOptions,
} from "./WorkspaceProvisioning.js";
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
import { assertWorkspaceRecord } from "./WorkspaceRecord.js";
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
    workspaceMigrations,
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
/** A stored failure is something a person reads, not a stack trace to keep whole. */
const MAX_ERROR_LENGTH = 500;
/** A burst of file events inside this window becomes a single replication pass. */
const WORKSPACE_SYNC_DEBOUNCE_MS = 300;
/** How many interrupted checkouts are carried forward at once on startup. */
const WORKSPACE_INITIALIZATION_CONCURRENCY = 4;

/** What owns a directory: always a project, and a workspace too when the folder is one. */
export interface ResolvedProjectOwnership {
    readonly project: Project;
    readonly workspace?: Workspace;
}

export const workspaceIdFactorySchema = Type.Function(
    [workspaceContextSchema],
    Type.Union([workspaceIdSchema, Type.Promise(workspaceIdSchema)]),
);
export const workspaceEventIdFactorySchema = Type.Function(
    [workspaceContextSchema],
    Type.Union([workspaceEventIdSchema, Type.Promise(workspaceEventIdSchema)]),
);
export const workspaceClockSchema = Type.Function(
    [workspaceContextSchema],
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
        idFactory: Type.Optional(workspaceIdFactorySchema),
        eventIdFactory: Type.Optional(workspaceEventIdFactorySchema),
        clock: Type.Optional(workspaceClockSchema),
        listener: Type.Optional(workspaceModuleListenerSchema),
        maxPageSize: Type.Optional(workspaceMaxPageSizeSchema),
        maxOutputCharacters: Type.Optional(workspaceMaxOutputSchema),
        onPostCommitError: Type.Optional(workspacePostCommitErrorSchema),
        onHostError: Type.Optional(workspaceHostErrorSchema),

        /**
         * The projects catalog these workspaces are cut from.
         *
         * A workspace belongs to a project: it is a branch of that project's repository, in a
         * folder named after it, cut from the trunk that project decided on. Everything the
         * workspaces catalog does with Git therefore starts by asking the projects catalog, which
         * owns the folder, the credential, and the repository lock.
         */
        projects: Type.Optional(workspaceProjectsModuleSchema),
        /**
         * The lifetime the catalog's own Git and filesystem work runs on: a detached root carrying
         * the agent database. Cutting a worktree, running setup commands, replicating files, and
         * removing a folder all outlive the call that asked for them.
         */
        rootContext: Type.Optional(workspaceRootContextSchema),
        /** Replaces both Git surfaces at once, so a test can drive lifecycle without Git. */
        git: Type.Optional(workspaceGitRunnerSchema),
        /** The read-only Git surface used to look at a folder without changing it. */
        probeGit: Type.Optional(workspaceGitRunnerSchema),
        environment: Type.Optional(workspaceEnvironmentSchema),
        homeDirectory: Type.Optional(Type.String({ minLength: 1 })),
        /** Where workspace folders are created. Defaults to the user-facing managed root. */
        workspacesDirectory: Type.Optional(Type.String({ minLength: 1 })),
        /** The configured defaults for setup commands, file sync, and keeping folders. */
        settings: Type.Optional(workspaceFolderSettingsOptionSchema),
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
    readonly #operations: WorkspaceHost;
    readonly #enabled: boolean;
    readonly #idFactory: NonNullable<WorkspaceModuleOptions["idFactory"]>;
    readonly #maxPageSize: number;
    readonly #maxOutputCharacters: number;
    readonly #onHostError: WorkspaceModuleOptions["onHostError"];
    readonly #cleanupTasks = new Set<Promise<void>>();
    #agents: AgentSystemRef | undefined;

    // --- The catalog's own Git and filesystem work -------------------------------------------

    readonly #backgroundAbort = new AbortController();
    readonly #environment: NodeJS.ProcessEnv;
    readonly #folderSettingsDefaults: WorkspaceFolderSettings;
    readonly #git: GitCommandRunner;
    readonly #homeDirectory: string;
    readonly #probeGit: GitCommandRunner;
    readonly #projectFolders = new Map<string, { path: string; storageKey: string }>();
    readonly #projects: ProjectsModule | undefined;
    readonly #rootContext: RootContext | undefined;
    readonly #setupControllers = new Map<string, AbortController>();
    readonly #syncLocks: MapAsyncLock<string> = mapAsyncLock();
    readonly #syncStops = new Map<string, () => void>();
    readonly #syncTimers = new Map<string, NodeJS.Timeout>();
    readonly #tasks = new Set<Promise<void>>();
    readonly #workspaceLocks: MapAsyncLock<string> = mapAsyncLock();
    readonly #workspacesDirectory: string;

    #closed = false;

    constructor(options: WorkspaceModuleOptions) {
        assertWorkspaceModuleOptions(options);
        this.#projects = options.projects;
        this.#rootContext = options.rootContext;
        this.#environment = options.environment ?? process.env;
        this.#folderSettingsDefaults = options.settings ?? DEFAULT_WORKSPACE_FOLDER_SETTINGS;
        this.#git = options.git ?? options.projects?.git ?? directGitCommandRunner;
        this.#probeGit = options.probeGit ?? options.git ?? options.projects?.probeGit ?? this.#git;
        this.#homeDirectory = normalizeProjectCwd(options.homeDirectory ?? homedir());
        this.#workspacesDirectory = normalizeFuturePath(
            options.workspacesDirectory ??
                getManagedWorkspacesDirectory(this.#environment, this.#homeDirectory),
        );
        // The catalog's own Git and filesystem work, given to the store as the operations it may
        // ask for while it decides. Nothing here comes from outside the module.
        this.#operations = {
            pathForStorageKey: (projectRef, storageKey) =>
                join(this.#workspaceRoot(projectRef), storageKey),
            isBranchUnavailable: (projectRef, branch) => {
                const folder = this.#projectFolders.get(projectRef);
                if (folder === undefined) return false;
                return gitBranchExists(workspaceGitRefSnapshot(folder.path), branch);
            },
            isStorageKeyUnavailable: (projectRef, storageKey) => {
                const folder = this.#projectFolders.get(projectRef);
                if (folder === undefined) return false;
                return workspaceStorageKeyExists(
                    workspaceGitRefSnapshot(folder.path),
                    this.#workspaceRoot(projectRef),
                    storageKey,
                );
            },
            branchMetadata: async (ctx, workspaceId) =>
                await this.#readBranchMetadata(ctx, workspaceId),
        };
        this.#store = createWorkspaceStore({ host: this.#operations });
        this.#enabled = options.enabled ?? true;
        this.#idFactory =
            options.idFactory ??
            ((_ctx: Context) => globalThis.crypto.randomUUID());
        this.#maxPageSize = options.maxPageSize ?? DEFAULT_PAGE_SIZE;
        this.#maxOutputCharacters = options.maxOutputCharacters ?? DEFAULT_OUTPUT_CHARACTERS;
        this.#onHostError = options.onHostError;
        this.#mutations = new WorkspaceMutations({
            store: this.#store,
            eventIdFactory:
                options.eventIdFactory ??
                ((_ctx: Context) => globalThis.crypto.randomUUID()),
            clock: options.clock ?? ((_ctx: Context) => Date.now()),
            listener: options.listener,
            onPostCommitError: options.onPostCommitError,
        });

        // Archiving a project archives everything cut from it. The decision belongs to the
        // projects catalog, so this catalog listens for it inside that transaction rather than
        // asking the projects catalog to know about workspaces.
        options.projects?.addProjectListener({
            onEventTransactional: async (txCtx, event) => {
                if (event.type !== "project_archived") return;
                await this.#archiveProjectWorkspaces(txCtx, event.project.id);
            },
        });
    }

    readonly #hooks: AgentModuleHooks = {
        tools: async (ctx: Context, scope: AgentModuleScope): Promise<readonly AnyAgentTool[]> => {
            if (!this.#enabled) return [];
            const agents = this.#agents;
            if (agents === undefined) {
                throw new Error("The workspaces module was asked for tools before it started.");
            }
            // Workspaces belong to the conversation a person is having. A subagent is one pair of
            // hands inside the task it was given, and stays in the workspace it was started in.
            if ((await agents.parentOf(ctx, scope.agent.id)) !== null) return [];
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

    readonly beforeStart = (_ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        this.#agents = agents;
        return this.#hooks;
    };

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
        input: WorkspaceReserveInput,
        hooks: WorkspaceReserveHooks = {},
    ): Promise<WorkspaceReservation> {
        this.#assertEnabled();
        this.#assertInput(workspaceReserveInputSchema, input, "workspace reservation");
        if (!Value.Check(workspaceReserveHooksSchema, hooks)) {
            throw new Error("Workspace reservation hooks are invalid.");
        }
        const normalized = structuredClone(input);
        const workspaceId =
            normalized.id ??
            normalized.operationId ??
            (await this.#newIdentity(ctx, workspaceIdSchema));
        const result = await this.#mutateResult(
            ctx,
            "reserve",
            normalized.operationId,
            workspaceId,
            async (txCtx, request) =>
                await this.#store.reserve(
                    txCtx,
                    {
                        id: workspaceId,
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
                    ? { type: "workspace_created", workspace: after }
                    : undefined,
        );
        return { created: result.changed, workspace: result.workspace };
    }

    /** Renames a workspace on a person's behalf, and moves its branch with the name. */
    async rename(ctx: Context, input: WorkspaceRenameInput): Promise<Workspace> {
        this.#assertEnabled();
        this.#assertInput(workspaceRenameInputSchema, input, "workspace rename");
        const normalized = structuredClone(input);
        let previousBranch: string | undefined;
        const renamed = await this.#mutate(
            ctx,
            "rename",
            normalized.operationId,
            normalized.workspaceId,
            async (txCtx, request) =>
                await this.#store.rename(
                    txCtx,
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
                    workspace: after,
                    previousName: before.name,
                };
            },
        );
        if (previousBranch === undefined || previousBranch === renamed.branch) return renamed;
        return await this.#moveHostBranch(ctx, renamed, previousBranch);
    }

    /**
     * Gives a workspace the name its first chat arrived at. A workspace someone has already named
     * keeps that name: only a placeholder is replaced.
     */
    async inheritName(
        ctx: Context,
        input: WorkspaceInheritNameInput,
    ): Promise<Workspace> {
        this.#assertEnabled();
        this.#assertInput(workspaceInheritNameInputSchema, input, "workspace name inheritance");
        const normalized = structuredClone(input);
        let previousBranch: string | undefined;
        const named = await this.#mutate(
            ctx,
            "inherit_name",
            normalized.operationId,
            normalized.workspaceId,
            async (txCtx, request) =>
                await this.#store.inheritName(
                    txCtx,
                    { workspaceId: normalized.workspaceId, name: normalized.name },
                    request,
                ),
            (before, after) => {
                if (before === undefined || before.name === after.name) return undefined;
                previousBranch = before.branch;
                return {
                    type: "workspace_renamed",
                    workspace: after,
                    previousName: before.name,
                };
            },
        );
        if (previousBranch === undefined || previousBranch === named.branch) return named;
        return await this.#moveHostBranch(ctx, named, previousBranch);
    }

    /** Records the branch a host actually created or renamed to. */
    async setBranch(
        ctx: Context,
        input: WorkspaceSetBranchInput,
    ): Promise<Workspace> {
        this.#assertEnabled();
        this.#assertInput(workspaceSetBranchInputSchema, input, "workspace branch");
        const normalized = structuredClone(input);
        return await this.#mutate(
            ctx,
            "set_branch",
            normalized.operationId,
            normalized.workspaceId,
            async (txCtx, request) =>
                await this.#store.setBranch(
                    txCtx,
                    { workspaceId: normalized.workspaceId, branch: normalized.branch },
                    request,
                ),
            (_before, after) => ({
                type: "workspace_updated",
                change: "set_branch",
                workspace: after,
            }),
        );
    }

    /** Records the base commit, base ref, and shared Git directory the host resolved. */
    async recordInitialization(
        ctx: Context,
        input: WorkspaceRecordInitializationInput,
    ): Promise<Workspace> {
        this.#assertEnabled();
        this.#assertInput(
            workspaceRecordInitializationInputSchema,
            input,
            "workspace initialization",
        );
        const normalized = structuredClone(input);
        return await this.#mutate(
            ctx,
            "record_initialization",
            normalized.operationId,
            normalized.workspaceId,
            async (txCtx, request) =>
                await this.#store.recordInitialization(
                    txCtx,
                    { workspaceId: normalized.workspaceId, facts: normalized.facts },
                    request,
                ),
            (_before, after) => ({
                type: "workspace_updated",
                change: "record_initialization",
                workspace: after,
            }),
        );
    }

    /** The workspace is checked out, set up, and ready for someone to work in. */
    async markReady(
        ctx: Context,
        input: WorkspaceMarkReadyInput,
    ): Promise<Workspace> {
        this.#assertEnabled();
        this.#assertInput(workspaceMarkReadyInputSchema, input, "workspace readiness");
        const normalized = structuredClone(input);
        return await this.#mutate(
            ctx,
            "mark_ready",
            normalized.operationId,
            normalized.workspaceId,
            async (txCtx, request) =>
                await this.#store.markReady(
                    txCtx,
                    { workspaceId: normalized.workspaceId },
                    request,
                ),
            (_before, after) => ({
                type: "workspace_updated",
                change: "mark_ready",
                workspace: after,
            }),
        );
    }

    /** A ready workspace stopped working, with a bounded explanation of why. */
    async markFailed(
        ctx: Context,
        input: WorkspaceMarkFailedInput,
    ): Promise<Workspace> {
        this.#assertEnabled();
        this.#assertInput(workspaceMarkFailedInputSchema, input, "workspace failure");
        const normalized = structuredClone(input);
        return await this.#mutate(
            ctx,
            "mark_failed",
            normalized.operationId,
            normalized.workspaceId,
            async (txCtx, request) =>
                await this.#store.markFailed(
                    txCtx,
                    { workspaceId: normalized.workspaceId, error: normalized.error },
                    request,
                ),
            (_before, after) => ({
                type: "workspace_updated",
                change: "mark_failed",
                workspace: after,
            }),
        );
    }

    /** Provisioning never finished. The attempt is counted so a retry can be decided later. */
    async markInitializationFailed(
        ctx: Context,
        input: WorkspaceMarkFailedInput,
    ): Promise<Workspace> {
        this.#assertEnabled();
        this.#assertInput(
            workspaceMarkFailedInputSchema,
            input,
            "workspace initialization failure",
        );
        const normalized = structuredClone(input);
        return await this.#mutate(
            ctx,
            "mark_initialization_failed",
            normalized.operationId,
            normalized.workspaceId,
            async (txCtx, request) =>
                await this.#store.markInitializationFailed(
                    txCtx,
                    { workspaceId: normalized.workspaceId, error: normalized.error },
                    request,
                ),
            (_before, after) => ({
                type: "workspace_updated",
                change: "mark_initialization_failed",
                workspace: after,
            }),
        );
    }

    /** Moves a workspace in the main list, placing it after another one or at the top. */
    async reorder(ctx: Context, input: WorkspaceReorderInput): Promise<Workspace> {
        this.#assertEnabled();
        this.#assertInput(workspaceReorderInputSchema, input, "workspace reorder");
        const normalized = structuredClone(input);
        return await this.#mutate(
            ctx,
            "reorder",
            normalized.operationId,
            normalized.workspaceId,
            async (txCtx, request) =>
                await this.#store.reorder(
                    txCtx,
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
        workspaceId: string,
        options: WorkspaceArchiveOptions = {},
    ): Promise<Workspace> {
        this.#assertEnabled();
        this.#assertId(workspaceId, "workspace");
        this.#assertInput(workspaceArchiveOptionsSchema, options, "workspace archive");
        const normalized = structuredClone(options);
        return await this.#mutate(
            ctx,
            "begin_archive",
            normalized.operationId,
            workspaceId,
            async (txCtx, request) =>
                await this.#store.beginArchive(
                    txCtx,
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
                change: "begin_archive",
                workspace: after,
            }),
        );
    }

    /** Records that the host finished taking the workspace's folder or worktree away. */
    async completeArchive(
        ctx: Context,
        workspaceId: string,
        options: WorkspaceArchiveOptions = {},
    ): Promise<Workspace> {
        this.#assertEnabled();
        this.#assertId(workspaceId, "workspace");
        this.#assertInput(workspaceArchiveOptionsSchema, options, "workspace archive completion");
        const normalized = structuredClone(options);
        return await this.#mutate(
            ctx,
            "complete_archive",
            normalized.operationId,
            workspaceId,
            async (txCtx, request) =>
                await this.#store.completeArchive(txCtx, { workspaceId }, request),
            (_before, after) => ({ type: "workspace_archived", workspace: after }),
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
        workspaceId: string,
        options: WorkspaceArchiveOptions = {},
    ): Promise<Workspace> {
        const begun = await this.beginArchive(ctx, workspaceId, options);
        if (begun.status !== "archiving") return begun;
        if (this.#rootContext === undefined) {
            return await this.completeArchive(ctx, workspaceId);
        }
        this.#runCleanup(this.#rootContext.named("workspace-cleanup"), async (workerCtx) => {
            await this.removeArchivedWorkspace(workerCtx, begun.projectRef, workspaceId);
        });
        return begun;
    }

    // --- Folders, Git, and setup -------------------------------------------------------------
    //
    // Everything below is the work the records describe: managed folders, worktrees and copies,
    // setup commands, file replication, branch moves, folder removal, and the background work that
    // carries a reservation through to a usable checkout. The catalog does it itself.

    /** Where workspace folders are created. */
    get managedWorkspacesDirectory(): string {
        return this.#workspacesDirectory;
    }

    /**
     * Picks up whatever the last run left unfinished: workspaces still being created, and the file
     * replication watch for every workspace that is ready.
     */
    async open(ctx: Context): Promise<void> {
        for (const workspace of await this.#allWorkspaces(ctx)) {
            if (workspace.status === "ready") this.#scheduleSync(workspace.projectRef);
        }
        this.#runInBackground("workspace-initialization", async (workerCtx) => {
            await this.reconcileInitializingWorkspaces(workerCtx);
        });
    }

    /** Stops every background lifetime this catalog started and waits for the ones in flight. */
    async close(_ctx: Context): Promise<void> {
        this.#closed = true;
        this.#backgroundAbort.abort();
        for (const controller of this.#setupControllers.values()) {
            controller.abort(new Error("Workspace setup stopped because Rig is closing."));
        }
        this.#setupControllers.clear();
        for (const timer of this.#syncTimers.values()) clearTimeout(timer);
        this.#syncTimers.clear();
        for (const stop of this.#syncStops.values()) stop();
        this.#syncStops.clear();
        await this.whenCleanupSettles();
        while (this.#tasks.size > 0) {
            await Promise.allSettled([...this.#tasks]);
        }
    }

    /**
     * Reserves one workspace and starts building it.
     *
     * Reservation is durable and happens first: the name, folder key and branch are decided in the
     * catalog, against a real snapshot of Git's refs and the managed directory, before anything
     * touches the disk. Only then does the checkout begin, in the background, so the caller is not
     * held while Git works.
     */
    async createWorkspace(
        ctx: Context,
        projectId: string,
        request: CreateWorkspaceRequest,
        creatorSessionId?: string,
        options: WorkspaceCreatorOptions = {},
    ): Promise<Workspace | undefined> {
        const projects = this.#requireProjects();
        const project = await this.#project(ctx, projectId);
        if (project === undefined) return undefined;
        if (request.secret !== undefined && project.remoteSource?.kind !== "github") {
            throw new Error("GitHub credentials can only be used with a GitHub project.");
        }
        const name = validateProjectName(request.name);
        const requestedId =
            request.id === undefined ? undefined : clientChosenId(request.id, "workspace");
        const baseRef = requestedBaseRef(request.baseRef);
        const creator = options.createdBy;
        if (options.githubToken !== undefined && creator !== undefined) {
            await projects.registerGitCredential(
                ctx,
                projectId,
                creator,
                options.githubToken,
            );
        }
        if (
            project.requiredSecretKind === "github" &&
            (creator === undefined || projects.gitAuthentication(projectId, creator) === undefined)
        ) {
            throw new Error("GitHub credentials are unavailable for this workspace.");
        }

        const kind = await this.#workspaceKindFor(ctx, project);
        const workspaceRoot = this.#workspaceRoot(projectId);
        const workspaceId = requestedId ?? createId();
        const gitRefs = workspaceGitRefSnapshot(project.repositoryRef);
        const fallbackStorageKey = `${projectStorageKey(name).slice(0, 20)}-${workspaceId}`;

        const reserved = await this.reserve(
            ctx,
            {
                id: workspaceId,
                projectRef: projectId,
                name,
                kind,
                ...(request.nameConfigured === undefined
                    ? {}
                    : { nameConfigured: request.nameConfigured }),
                ...(baseRef === undefined ? {} : { baseRef }),
                ...(creatorSessionId === undefined ? {} : { creatorSessionId }),
                ...(gitRefs.complete ? {} : { storageKeySeed: fallbackStorageKey }),
            },
            {
                isBranchUnavailable: (branch) => gitBranchExists(gitRefs, branch),
                isStorageKeyUnavailable: (storageKey) =>
                    workspaceStorageKeyExists(gitRefs, workspaceRoot, storageKey),
                pathForStorageKey: (storageKey) => join(workspaceRoot, storageKey),
            },
        );
        if (reserved.created) {
            const workspace = reserved.workspace;
            this.#runInBackground("workspace-initialization", async (workerCtx) => {
                await this.#initializeWorkspace(workerCtx, workspace);
            });
        }
        return reserved.workspace;
    }

    /**
     * Finds what owns a directory, importing the directory as a project if it is new.
     *
     * A folder that is a workspace answers with both the workspace and its project; any other
     * folder is resolved by the projects catalog alone.
     */
    async resolvePath(
        ctx: Context,
        cwd: string,
        assertedWorkspaceId?: string,
        requestedProjectId?: string,
    ): Promise<ResolvedProjectOwnership> {
        const projects = this.#requireProjects();
        const path = normalizeProjectCwd(cwd);
        const workspace = await this.getByPath(ctx, path);
        if (workspace !== undefined) {
            if (workspace.status !== "ready") {
                throw new ProjectRegistrationError(
                    "managed_workspace_unavailable",
                    `The workspace "${workspace.name}" ${workspaceStatusText(workspace.status)}.`,
                );
            }
            if (assertedWorkspaceId !== undefined && assertedWorkspaceId !== workspace.id) {
                throw new Error("The workspace ID does not match the session directory.");
            }
            const project = await this.#project(ctx, workspace.projectRef);
            if (project === undefined) {
                throw new ProjectRegistrationError(
                    "managed_workspace_unavailable",
                    "The workspace's project was not found.",
                );
            }
            return {
                project:
                    project.status === "archived"
                        ? await projects.restore(ctx, project.id)
                        : project,
                workspace,
            };
        }
        if (assertedWorkspaceId !== undefined) {
            throw new Error("The workspace ID does not match the session directory.");
        }
        return {
            project: this.#remember(
                await projects.resolvePath(
                    ctx,
                    path,
                    ...(requestedProjectId === undefined ? [] : [requestedProjectId]),
                ),
            ),
        };
    }

    /**
     * Resolves the explicit durable owner of a new session.
     *
     * Unlike generic path resolution, this accepts a workspace whose folder does not exist yet.
     * The caller has to name both its reserved identity and its exact future path.
     */
    async resolveSessionOwnership(
        ctx: Context,
        cwd: string,
        workspaceId: string,
        assertedProjectId?: string,
    ): Promise<ResolvedProjectOwnership> {
        const projects = this.#requireProjects();
        const path = normalizeProjectCwd(cwd);
        const workspace = await this.get(ctx, workspaceId);
        if (workspace === undefined || workspace.path !== path) {
            throw new Error("The workspace ID does not match the session directory.");
        }
        if (assertedProjectId !== undefined && workspace.projectRef !== assertedProjectId) {
            throw new Error("The workspace does not belong to that project.");
        }
        if (workspace.status !== "initializing" && workspace.status !== "ready") {
            throw new ProjectRegistrationError(
                "managed_workspace_unavailable",
                `The workspace "${workspace.name}" ${workspaceStatusText(workspace.status)}.`,
            );
        }
        if (
            workspace.status === "ready" &&
            (workspace.presence !== "present" || !existsSync(workspace.path))
        ) {
            throw new ProjectRegistrationError(
                "managed_workspace_unavailable",
                `The workspace "${workspace.name}" is not available right now.`,
            );
        }
        const project = await this.#project(ctx, workspace.projectRef);
        if (project === undefined) {
            throw new ProjectRegistrationError(
                "managed_workspace_unavailable",
                "The workspace's project was not found.",
            );
        }
        return {
            project:
                project.status === "archived"
                    ? await projects.restore(ctx, project.id)
                    : project,
            workspace,
        };
    }

    /** A project Git cannot cut a worktree from still gets a workspace: a copy of the folder. */
    async #workspaceKindFor(
        ctx: Context,
        project: Project,
    ): Promise<"git_worktree" | "directory"> {
        if (project.worktreeSupport === "supported") return "git_worktree";
        if (project.worktreeSupport === "unsupported") return "directory";
        const probed = this.#remember(
            await this.#requireProjects().probe(ctx, project.id),
        );
        return probed.worktreeSupport === "supported" ? "git_worktree" : "directory";
    }

    #workspaceRoot(projectId: string): string {
        const storageKey = this.#projectFolders.get(projectId)?.storageKey ?? projectId;
        return join(this.#workspacesDirectory, storageKey);
    }

    // --- Building a workspace ----------------------------------------------------------------

    /** Carries every workspace that is still being created through to a usable checkout. */
    async reconcileInitializingWorkspaces(ctx: Context): Promise<void> {
        const workspaces = (await this.#allWorkspaces(ctx)).filter(
            (workspace) => workspace.status === "initializing",
        );
        let next = 0;
        const worker = async (): Promise<void> => {
            for (;;) {
                if (this.#closed) return;
                const workspace = workspaces[next++];
                if (workspace === undefined) return;
                await this.#initializeWorkspace(ctx, workspace);
            }
        };
        await Promise.all(
            Array.from(
                { length: Math.min(WORKSPACE_INITIALIZATION_CONCURRENCY, workspaces.length) },
                worker,
            ),
        );
    }

    async #initializeWorkspace(ctx: Context, workspace: Workspace): Promise<void> {
        await this.#workspaceLocks.runInLock(ctx, workspace.id, async () => {
            const project = await this.#project(ctx, workspace.projectRef);
            if (project === undefined) {
                await this.#failInitialization(
                    ctx,
                    workspace.id,
                    "The workspace's project was not found.",
                );
                return;
            }
            try {
                const current = await this.#requireProjects().runInProjectGitLock(
                    ctx,
                    workspace.projectRef,
                    async () => await this.#createContentsLocked(ctx, workspace, project),
                );
                if (current === undefined || this.#closed) return;
                await this.#setupWorkspace(ctx, current);
                if (this.#closed) return;
                await this.markReady(ctx, { workspaceId: current.id });
                this.#scheduleSync(current.projectRef);
            } catch (error) {
                if (this.#closed) return;
                await this.#failInitialization(ctx, workspace.id, errorToMessage(error));
            }
        });
    }

    /** Everything that must happen while this project's Git lock is held. */
    async #createContentsLocked(
        ctx: Context,
        workspace: Workspace,
        project: Project,
    ): Promise<Workspace | undefined> {
        let locked = await this.#ownedWorkspace(ctx, workspace.projectRef, workspace.id);
        if (locked?.status !== "initializing") return undefined;

        if (locked.kind === "directory") {
            if (existsSync(locked.path)) return locked;
            if (this.#closed) return undefined;
            await copyProjectFolder({
                projectPath: project.repositoryRef,
                workspacePath: locked.path,
            });
            return locked;
        }

        locked = await this.#prepareInitialization(ctx, locked, project);
        if (locked?.status !== "initializing") return undefined;
        if (existsSync(locked.path)) {
            const adoptable =
                locked.gitCommonDir !== undefined &&
                (await isGitWorktreeAt({
                    commonDir: locked.gitCommonDir,
                    git: this.#git,
                    path: locked.path,
                }));
            if (adoptable) return locked;
            // A half-made worktree is cleaned up before creation is tried again. The keep-on-
            // archive settings do not apply: this folder was never a workspace someone worked in.
            await removeWorkspaceDirectory({
                git: this.#git,
                keepCopiesOnArchive: false,
                keepWorktreesOnArchive: false,
                project,
                stopped: () => this.#closed,
                workspace: locked,
            });
        }
        if (this.#closed) return undefined;
        // The workspace is anchored to the commit it was reserved on, so an interrupted creation
        // resumes onto exactly the base it was promised.
        if (locked.baseCommit === undefined) {
            throw new Error("The workspace has no base commit to start from.");
        }
        await this.#createCheckoutLocked(
            ctx,
            locked,
            project.repositoryRef,
            locked.baseCommit,
        );
        return locked;
    }

    async #prepareInitialization(
        ctx: Context,
        workspace: Workspace,
        project: Project,
    ): Promise<Workspace | undefined> {
        if (workspace.baseCommit !== undefined && workspace.gitCommonDir !== undefined) {
            return workspace;
        }
        const projects = this.#requireProjects();
        const git = projects.gitForProject(project.id);
        if ((await readGitTopLevel(git, project.repositoryRef)) !== project.repositoryRef) {
            throw new Error("A workspace worktree needs a Git repository project.");
        }
        const defaultBranch =
            workspace.baseRef === undefined
                ? (await projects.resolveDefaultBranch(ctx, project.id)).defaultBranch
                : undefined;
        const gitCommonDir = await readGitCommonDir(git, project.repositoryRef);
        const base = await resolveWorkspaceBase({
            ...(defaultBranch === undefined ? {} : { defaultBranch }),
            git,
            projectPath: project.repositoryRef,
            ...(workspace.baseRef === undefined ? {} : { requestedRef: workspace.baseRef }),
        });
        if (this.#closed) return undefined;
        return await this.recordInitialization(ctx, {
            workspaceId: workspace.id,
            facts: { baseCommit: base.commit, baseRef: base.ref, gitCommonDir },
        });
    }

    async #createCheckoutLocked(
        ctx: Context,
        workspace: Workspace,
        projectPath: string,
        commit: string,
    ): Promise<void> {
        if (this.#closed) return;
        // The branch may already have followed a rename made while the checkout was reserved.
        const branch =
            (await this.#ownedWorkspace(ctx, workspace.projectRef, workspace.id))
                ?.branch ?? workspace.branch;
        await createGitWorktree({
            branch,
            commit,
            expectedCommonDir: workspace.gitCommonDir ?? "",
            git: this.#git,
            projectPath,
            workspacePath: workspace.path,
        });
        // A rename landing during the checkout is not moved by the branch mover, which leaves
        // workspaces that are not ready alone. The branch Git just created is the real one.
        if (this.#closed) return;
        const stored = await this.#ownedWorkspace(ctx, workspace.projectRef, workspace.id);
        if (stored === undefined || stored.branch === branch) return;
        await this.setBranch(ctx, { workspaceId: workspace.id, branch });
        await this.#reportHostError(
            ctx,
            workspace.id,
            "rename",
            new Error(
                `The workspace was renamed while it was being created, so its branch stayed "${branch}".`,
            ),
        );
    }

    async #setupWorkspace(ctx: Context, workspace: Workspace): Promise<void> {
        const controller = new AbortController();
        this.#setupControllers.set(workspace.id, controller);
        try {
            if (
                (await this.#ownedWorkspace(ctx, workspace.projectRef, workspace.id))
                    ?.status !== "initializing"
            ) {
                return;
            }
            const project = await this.#project(ctx, workspace.projectRef);
            // The first replication runs before the setup commands so they can rely on the shared
            // files being there. The sync list is read from the project root — the same source
            // every later pass uses — so an uncommitted change to it applies immediately.
            if (project !== undefined) {
                const rootSettings = await this.#folderSettings(project.repositoryRef);
                await syncWorkspaceFiles({
                    paths: [...rootSettings.sync, ...rootSettings.protectedSync],
                    projectPath: project.repositoryRef,
                    workspacePath: workspace.path,
                });
            }
            const settings = await this.#folderSettings(workspace.path);
            await runWorkspaceSetupCommands(ctx, workspace.path, settings.setupCommands, {
                environment: this.#environment,
                signal: controller.signal,
            });
        } finally {
            if (this.#setupControllers.get(workspace.id) === controller) {
                this.#setupControllers.delete(workspace.id);
            }
        }
    }

    async #failInitialization(
        ctx: Context,
        workspaceId: string,
        message: string,
    ): Promise<void> {
        await this.markInitializationFailed(ctx, {
            workspaceId,
            error: boundedWorkspaceError(message),
        });
    }

    async #folderSettings(folder: string): Promise<WorkspaceFolderSettings> {
        return await loadWorkspaceFolderSettings(folder, this.#folderSettingsDefaults);
    }

    // --- Archival ----------------------------------------------------------------------------

    /** Cleans up an archived workspace's folder. Failure is logged; archival still stands. */
    async removeArchivedWorkspace(
        ctx: Context,
        projectId: string,
        workspaceId: string,
    ): Promise<Workspace | undefined> {
        await this.#workspaceLocks.runInLock(ctx, workspaceId, async () => {
            const workspace = await this.#ownedWorkspace(ctx, projectId, workspaceId);
            if (workspace === undefined || workspace.status === "archived") return;
            if (workspace.status !== "archiving") {
                throw new Error("That workspace is not being archived.");
            }
            const project = await this.#project(ctx, projectId);
            if (project === undefined) throw new Error("The workspace's project was not found.");
            const settings = await this.#folderSettings(project.repositoryRef);
            try {
                await removeWorkspaceDirectory({
                    git: this.#git,
                    keepCopiesOnArchive: settings.keepCopiesOnArchive,
                    keepWorktreesOnArchive: settings.keepWorktreesOnArchive,
                    project,
                    stopped: () => this.#closed,
                    workspace,
                });
                if (this.#closed) return;
            } catch (error) {
                if (this.#closed) return;
                await this.#reportHostError(ctx, workspaceId, "archive", error);
            }
            await this.completeArchive(ctx, workspaceId);
            // The next pass stops the watch when this was the project's last ready workspace.
            this.#scheduleSync(projectId);
        });
        return await this.#ownedWorkspace(ctx, projectId, workspaceId);
    }

    /**
     * Archives everything cut from a project that has just been archived, inside that project's own
     * transaction, and removes the folders afterwards. A workspace of an archived project is not a
     * workspace anybody has any more, so it leaves the active list at the same moment.
     */
    async #archiveProjectWorkspaces(
        ctx: Context,
        projectId: string,
    ): Promise<void> {
        if (!this.#enabled) return;
        const workspaces = (await this.#allWorkspaces(ctx, projectId)).filter(
            (workspace) => workspace.status !== "archived" && workspace.status !== "archiving",
        );
        for (const workspace of workspaces) {
            await this.beginArchive(ctx, workspace.id);
            this.#stopSetup(workspace.id);
        }
        if (workspaces.length === 0 || this.#rootContext === undefined) return;
        this.#runCleanup(this.#rootContext.named("workspace-cleanup"), async (workerCtx) => {
            for (const workspace of workspaces) {
                await this.removeArchivedWorkspace(workerCtx, projectId, workspace.id);
            }
        });
    }

    #stopSetup(workspaceId: string): void {
        this.#setupControllers
            .get(workspaceId)
            ?.abort(new Error("Workspace setup stopped because the workspace was archived."));
    }

    // --- File replication --------------------------------------------------------------------

    /** Debounces the project's next sync pass, so a burst of file events becomes one copy. */
    #scheduleSync(projectId: string): void {
        if (this.#closed || this.#rootContext === undefined) return;
        clearTimeout(this.#syncTimers.get(projectId));
        const timer = setTimeout(() => {
            this.#syncTimers.delete(projectId);
            this.#runInBackground("workspace-sync", async (workerCtx) => {
                await this.#syncLocks.runInLock(workerCtx, projectId, async (lockedCtx) => {
                    await this.#runSyncPass(lockedCtx, projectId);
                });
            });
        }, WORKSPACE_SYNC_DEBOUNCE_MS);
        timer.unref?.();
        this.#syncTimers.set(projectId, timer);
    }

    /**
     * Replicates the project root's configured sync paths into every ready workspace, then re-arms
     * the watch from the current configuration. Sync is best-effort: one workspace failing to
     * receive a copy never fails the others, and a project left without ready workspaces simply
     * stops being watched.
     */
    async #runSyncPass(ctx: Context, projectId: string): Promise<void> {
        this.#syncStops.get(projectId)?.();
        this.#syncStops.delete(projectId);
        if (this.#closed) return;
        const project = await this.#project(ctx, projectId);
        const workspaces = (await this.#allWorkspaces(ctx, projectId)).filter(
            (workspace) => workspace.status === "ready",
        );
        if (project === undefined || workspaces.length === 0) return;
        const settings = await this.#folderSettings(project.repositoryRef);
        const syncPaths = [...new Set([...settings.sync, ...settings.protectedSync])];
        if (this.#closed) return;
        // The watch is armed even with nothing to sync: it also observes the project configuration
        // file, so a sync list added later is picked up without a restart.
        this.#syncStops.set(
            projectId,
            watchWorkspaceSyncPaths({
                onChange: () => {
                    this.#scheduleSync(projectId);
                },
                projectPath: project.repositoryRef,
                syncPaths,
            }),
        );
        for (const workspace of workspaces) {
            if (this.#closed) return;
            // Re-read right before copying: a workspace archived while this pass was running must
            // not have its folder written to, much less recreated.
            if (
                (await this.#ownedWorkspace(ctx, projectId, workspace.id))?.status !==
                "ready"
            ) {
                continue;
            }
            try {
                await syncWorkspaceFiles({
                    paths: syncPaths,
                    projectPath: project.repositoryRef,
                    workspacePath: workspace.path,
                });
            } catch {
                // Best-effort replication: the workspace converges on the next pass.
            }
        }
    }

    // --- Git facts ---------------------------------------------------------------------------

    /** Re-derives presence and Git facts for every workspace someone can work in. */
    async reconcileGitFacts(ctx: Context): Promise<void> {
        for (const workspace of await this.#allWorkspaces(ctx)) {
            if (this.#closed) return;
            if (workspace.status !== "ready") continue;
            const probe = await probeGitRepository({ git: this.#probeGit, path: workspace.path });
            if (this.#closed) return;
            await this.applyProbe(ctx, {
                workspaceId: workspace.id,
                presence: probe.presence,
                facts: projectGitFactsFrom(probe.facts ?? { ahead: 0, behind: 0, detached: false }),
            });
        }
    }

    /** Persists Git facts a live scan observed, so a commit reaches a client that is not watching. */
    async recordGitFacts(
        ctx: Context,
        workspaceId: string,
        facts: GitRepositoryFacts,
    ): Promise<void> {
        await this.applyGitFacts(ctx, {
            workspaceId,
            facts: projectGitFactsFrom(facts),
        });
    }

    /**
     * Looks at a workspace's branch as Git has it right now.
     *
     * The stored facts are a snapshot of the last scan; this question is asked when someone wants
     * the truth, so the folder is read rather than the row.
     */
    async #readBranchMetadata(
        ctx: Context,
        workspaceId: string,
    ): Promise<WorkspaceBranchMetadata> {
        const workspace = await this.#mutations.getRequired(ctx, workspaceId);
        const facts =
            workspace.presence === "missing"
                ? undefined
                : (await probeGitRepository({ git: this.#probeGit, path: workspace.path })).facts;
        return {
            workspaceId,
            ahead: facts?.ahead ?? 0,
            behind: facts?.behind ?? 0,
            detached: facts?.detached ?? false,
            ...(facts?.branch === undefined ? {} : { branch: facts.branch }),
            ...(facts?.head === undefined ? {} : { head: facts.head }),
            ...(facts?.upstream === undefined ? {} : { upstream: facts.upstream }),
        };
    }

    // --- Moving a session between workspaces -------------------------------------------------

    async validateSessionTransfer(
        ctx: Context,
        projectId: string,
        sourceWorkspaceId: string,
        targetWorkspaceId: string,
    ): Promise<{ source: Workspace; target: Workspace }> {
        if (sourceWorkspaceId === targetWorkspaceId) {
            throw new Error("Choose a different workspace to move the session into.");
        }
        const source = await this.#ownedWorkspace(ctx, projectId, sourceWorkspaceId);
        if (source === undefined) {
            throw new Error("The session's current workspace was not found.");
        }
        if (
            source.status !== "ready" ||
            source.presence !== "present" ||
            !existsSync(source.path)
        ) {
            throw new Error("The session's current workspace is not ready and available.");
        }
        const target = await this.#ownedWorkspace(ctx, projectId, targetWorkspaceId);
        if (target === undefined) {
            throw new Error("The workspace to move into was not found in this project.");
        }
        if (target.status !== "ready" || target.presence !== "present") {
            throw new Error("The workspace to move into must be ready and available.");
        }
        return { source, target };
    }

    async prepareSessionTransfer(
        ctx: Context,
        projectId: string,
        sourceWorkspaceId: string,
        targetWorkspaceId: string,
        beforeApply?: () => void | Promise<void>,
    ): Promise<{ prepared: PreparedWorkspaceTransfer; target: Workspace }> {
        const { source, target } = await this.validateSessionTransfer(
            ctx,
            projectId,
            sourceWorkspaceId,
            targetWorkspaceId,
        );
        try {
            return {
                prepared: await prepareWorkspaceTransfer({
                    ...(beforeApply === undefined ? {} : { beforeApply }),
                    git: this.#git,
                    sourcePath: source.path,
                    targetPath: target.path,
                }),
                target,
            };
        } catch (error) {
            if (!(error instanceof WorkspaceTransferTargetRestoreError)) throw error;
            throw await this.markSessionTransferTargetFailed(
                ctx,
                projectId,
                targetWorkspaceId,
                error,
            );
        }
    }

    /** A workspace left in an unknown state by a failed transfer is not offered again. */
    async markSessionTransferTargetFailed(
        ctx: Context,
        projectId: string,
        targetWorkspaceId: string,
        error: WorkspaceTransferTargetRestoreError,
    ): Promise<WorkspaceTransferTargetRestoreError> {
        const target = await this.#ownedWorkspace(ctx, projectId, targetWorkspaceId);
        if (target === undefined) return error;
        const failure = new WorkspaceTransferTargetRestoreError(
            error.originalError,
            error.restoreError,
            target.name,
        );
        await this.markFailed(ctx, {
            workspaceId: targetWorkspaceId,
            error: boundedWorkspaceError(failure.message),
        });
        return failure;
    }

    // --- Internals ---------------------------------------------------------------------------

    /** Every workspace this agent can see, archived ones included. */
    async #allWorkspaces(
        ctx: Context,
        projectId?: string,
    ): Promise<readonly Workspace[]> {
        return await this.list(ctx, {
            includeArchived: true,
            ...(projectId === undefined ? {} : { projectRef: projectId }),
        });
    }

    /** One workspace, but only if it belongs to the project the caller named. */
    async #ownedWorkspace(
        ctx: Context,
        projectId: string,
        workspaceId: string,
    ): Promise<Workspace | undefined> {
        const workspace = await this.get(ctx, workspaceId);
        return workspace?.projectRef === projectId ? workspace : undefined;
    }

    /** The project a workspace belongs to, remembering its folder for later reservations. */
    async #project(ctx: Context, projectId: string): Promise<Project | undefined> {
        const project = await this.#requireProjects().get(ctx, projectId);
        return project === undefined ? undefined : this.#remember(project);
    }

    /**
     * Remembers where a project lives.
     *
     * Deciding a folder key or a branch has to answer at once, from a snapshot of Git's refs and
     * the managed directory, so the folder cannot be looked up in the database at that moment. What
     * the catalog has already seen is enough: a project it has never read has nothing reserved.
     */
    #remember<T extends Project | undefined>(project: T): T {
        if (project !== undefined) {
            this.#projectFolders.set(project.id, {
                path: project.repositoryRef,
                storageKey: project.storageKey,
            });
        }
        return project;
    }

    #requireProjects(): ProjectsModule {
        const projects = this.#projects;
        if (projects === undefined) {
            throw new Error(
                "This workspaces catalog was built without a projects catalog, so it cannot create or set up workspaces.",
            );
        }
        return projects;
    }

    /**
     * Starts work that outlives whatever asked for it, on its own named lifetime. The caller's
     * context is deliberately not used: a background checkout must not end when a request does.
     */
    #runInBackground(name: string, work: (ctx: Context) => Promise<void>): void {
        if (this.#closed) return;
        const root = this.#rootContext;
        if (root === undefined) {
            throw new Error(
                "This workspaces catalog was built without a rootContext, so it cannot start background work.",
            );
        }
        const task = work(root.named(name))
            .catch(() => undefined)
            .finally(() => {
                this.#tasks.delete(task);
            });
        this.#tasks.add(task);
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
        input: WorkspaceApplyGitFactsInput,
    ): Promise<Workspace> {
        this.#assertEnabled();
        this.#assertInput(workspaceApplyGitFactsInputSchema, input, "workspace Git facts");
        const normalized = structuredClone(input);
        return await this.#mutate(
            ctx,
            "apply_git_facts",
            normalized.operationId,
            normalized.workspaceId,
            async (txCtx, request) =>
                await this.#store.applyGitFacts(
                    txCtx,
                    { workspaceId: normalized.workspaceId, facts: normalized.facts },
                    request,
                ),
            (_before, after) => ({
                type: "workspace_updated",
                change: "apply_git_facts",
                workspace: after,
            }),
        );
    }

    /** The same, plus whether the folder was still there when the host looked. */
    async applyProbe(
        ctx: Context,
        input: WorkspaceApplyProbeInput,
    ): Promise<Workspace> {
        this.#assertEnabled();
        this.#assertInput(workspaceApplyProbeInputSchema, input, "workspace probe");
        const normalized = structuredClone(input);
        return await this.#mutate(
            ctx,
            "apply_probe",
            normalized.operationId,
            normalized.workspaceId,
            async (txCtx, request) =>
                await this.#store.applyProbe(
                    txCtx,
                    {
                        workspaceId: normalized.workspaceId,
                        presence: normalized.presence,
                        facts: normalized.facts,
                    },
                    request,
                ),
            (_before, after) => ({
                type: "workspace_updated",
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
        query: WorkspacePageQuery = {},
    ): Promise<WorkspacePage> {
        this.#assertEnabled();
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
            this.#store.list(ctx, normalized),
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
        }
        return structuredClone(fitPageForModel(raw, this.#maxOutputCharacters));
    }

    async list(
        ctx: Context,
        query: WorkspacePageQuery = {},
    ): Promise<Workspace[]> {
        this.#assertEnabled();
        return (await this.listPage(ctx, query)).workspaces;
    }

    async get(ctx: Context, workspaceId: string): Promise<Workspace | undefined> {
        this.#assertEnabled();
        this.#assertId(workspaceId, "workspace");
        const raw = await requirePromise(
            this.#store.get(ctx, workspaceId),
            "Workspace store get",
        );
        if (raw === undefined) return undefined;
        assertWorkspace(raw);
        assertWorkspaceRecord(raw);
        if (raw.id !== workspaceId) {
            throw new Error("Workspace store returned a different workspace identity.");
        }
        return structuredClone(raw);
    }

    /** Resolves a folder to the workspace that lives in it, for a host resolving a cwd. */
    async getByPath(ctx: Context, path: string): Promise<Workspace | undefined> {
        this.#assertEnabled();
        if (typeof path !== "string" || path.length === 0) {
            throw new Error("Workspace path is invalid.");
        }
        const raw = await requirePromise(
            this.#store.getByPath(ctx, path),
            "Workspace store get by path",
        );
        if (raw === undefined) return undefined;
        assertWorkspace(raw);
        assertWorkspaceRecord(raw);
        if (raw.path !== path) {
            throw new Error("Workspace store returned a workspace with a different path.");
        }
        return structuredClone(raw);
    }

    /** Read one workspace with a bounded, cursor-addressable detail stream. */
    async getPage(
        ctx: Context,
        workspaceId: string,
        query: WorkspaceDetailQuery = {},
    ): Promise<WorkspaceDetailPage> {
        this.#assertEnabled();
        this.#assertId(workspaceId, "workspace");
        if (!Value.Check(workspaceDetailQuerySchema, query)) {
            throw new Error("Workspace detail query is invalid.");
        }
        const workspace = await this.get(ctx, workspaceId);
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
        input: WorkspaceTransferInput,
    ): Promise<WorkspaceTransferResult> {
        this.#assertEnabled();
        this.#assertInput(workspaceTransferInputSchema, input, "workspace transfer");
        const normalized = structuredClone(input);
        const request = stripOperationId(normalized);
        const operationId =
            normalized.operationId ??
            (await this.#newIdentity(ctx, workspaceOperationIdSchema));
        const mutationRequest: WorkspaceMutationRequest = { operation: "transfer", operationId };
        const subjectId =
            "workspaceId" in request ? request.workspaceId : request.targetWorkspaceId;

        const change = await this.#mutations.runTransaction(ctx, async (txCtx) => {
            const before = await this.#mutations.getRequired(txCtx, subjectId);
            const raw = await requirePromise(
                this.#store.transfer(txCtx, structuredClone(request), mutationRequest),
                "Workspace store transfer",
            );
            const result = normalizeTransferStoreResult(raw, operationId);
            if (result.operationId !== operationId) {
                throw new Error("Workspace transfer result identity does not match the request.");
            }
            assertTransferRequestResult(result, request);
            const after = await this.#mutations.getRequired(txCtx, subjectId);
            if ("workspaceId" in request && after.projectRef !== request.targetProjectRef) {
                throw new Error(
                    "Workspace project transfer did not reach the requested project reference.",
                );
            }
            if (!result.changed) return { result };
            const event =
                result.state === "scheduled"
                    ? await this.#mutations.newEvent(txCtx, {
                          type: "workspace_transfer_scheduled",
                          targetWorkspaceId: result.targetWorkspaceId,
                      })
                    : await this.#mutations.newEvent(txCtx, {
                          type: "workspace_transferred",
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
        workspaceId: string,
    ): Promise<WorkspaceBranchMetadata> {
        this.#assertEnabled();
        this.#assertId(workspaceId, "workspace");
        const workspace = await this.#mutations.getRequired(ctx, workspaceId);
        const raw = await requirePromise(
            this.#store.branchMetadata(ctx, workspaceId),
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
        workspaceId: string,
        query: WorkspaceBranchMetadataDetailQuery = {},
    ): Promise<WorkspaceBranchMetadataPage> {
        this.#assertEnabled();
        this.#assertId(workspaceId, "workspace");
        if (!Value.Check(workspaceBranchMetadataDetailQuerySchema, query)) {
            throw new Error("Workspace branch metadata detail query is invalid.");
        }
        const metadata = await this.branchMetadata(ctx, workspaceId);
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
            (await this.#newIdentity(ctx, workspaceOperationIdSchema));
        return await this.#mutations.runResult(
            ctx,
            operation,
            operationId,
            workspaceId,
            run,
            describe,
        );
    }

    /**
     * Moves the worktree's branch onto the name the workspace now has, after that name is durable.
     *
     * The rename is Git's work, and Git keeping the old branch is not a failure of the rename the
     * person asked for: the name stands, and the recorded branch goes back to the one Git actually
     * has. Every worktree of a project shares one set of refs, so this takes the project's Git lock
     * the way cutting a worktree does.
     */
    async #moveHostBranch(
        ctx: Context,
        workspace: Workspace,
        previousBranch: string,
    ): Promise<Workspace> {
        if (workspace.branch === previousBranch) return workspace;
        if (workspace.status !== "ready" || workspace.gitCommonDir === undefined) return workspace;
        const projects = this.#projects;
        try {
            const move = async (): Promise<void> => {
                await renameGitBranch({
                    expectedCommonDir: workspace.gitCommonDir ?? "",
                    from: previousBranch,
                    git: this.#git,
                    to: workspace.branch,
                    workspacePath: workspace.path,
                });
            };
            if (projects === undefined) {
                await move();
            } else {
                await projects.runInProjectGitLock(ctx, workspace.projectRef, move);
            }
            return workspace;
        } catch (error: unknown) {
            await this.#reportHostError(ctx, workspace.id, "rename", error);
            return await this.setBranch(ctx, {
                workspaceId: workspace.id,
                branch: previousBranch,
            });
        }
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
        schema: typeof workspaceIdSchema | typeof workspaceOperationIdSchema,
    ): Promise<string> {
        const raw = this.#idFactory(ctx);
        const value = isPromiseLike(raw) ? await raw : raw;
        if (!Value.Check(schema, value)) {
            throw new Error("Workspace identity factory returned an invalid identity.");
        }
        return value;
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
    operationId: string,
): WorkspaceTransferResult {
    if (Value.Check(workspaceTransferResultSchema, raw)) return structuredClone(raw);
    assertWorkspace(raw);
    assertWorkspaceRecord(raw);
    return {
        operationId,
        changed: true,
        state: "transferred",
        targetWorkspaceId: raw.id,
        workspace: {
            id: raw.id,
            projectRef: raw.projectRef,
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

/** Why a workspace cannot be worked in, said the way a person would say it. */
function workspaceStatusText(status: Workspace["status"]): string {
    switch (status) {
        case "initializing":
            return "is still being created";
        case "failed":
            return "could not be created";
        case "archiving":
            return "is being archived";
        case "archived":
            return "has been archived";
        default:
            return "is ready";
    }
}

function errorToMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return typeof error === "string" ? error : JSON.stringify(error);
}

/** A stored failure has to fit in a column and read as a sentence. */
function boundedWorkspaceError(message: string): string {
    const cleaned = message.replaceAll("\u0000", " ").trim();
    return (cleaned.length === 0 ? "Something went wrong." : cleaned).slice(0, MAX_ERROR_LENGTH);
}
