import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    workspaceAgentIdSchema,
    workspaceBranchSchema,
    workspaceGitCommonDirSchema,
    workspaceGitFactsSchema,
    workspaceIdSchema,
    workspaceKindSchema,
    workspaceMutationOperationSchema,
    workspaceNameSchema,
    workspaceOperationIdSchema,
    workspacePathSchema,
    workspacePresenceSchema,
    workspaceProjectRefSchema,
    workspaceReserveHooksSchema,
    workspaceSchema,
    workspaceSessionIdSchema,
    workspaceStorageKeySchema,
    workspaceBaseRefSchema,
    workspaceCommitSchema,
    workspaceErrorSchema,
    workspaceInitializationFactsSchema,
    workspaceVersionSchema,
    type Workspace,
    type WorkspaceGitFacts,
    type WorkspaceReserveHooks,
} from "./Workspace.js";
import { workspaceBranchName, workspaceNameKey } from "./WorkspaceIdentity.js";
import {
    workspaceBranchMetadataSchema,
    type WorkspaceBranchMetadata,
} from "./WorkspaceBranchMetadata.js";
import { workspaceContextSchema, workspaceEventSchema } from "./WorkspaceEvent.js";
import { workspaceMigrations } from "./WorkspaceMigrations.js";
import {
    workspacePageQuerySchema,
    workspacePageSchema,
    workspaceListSchema,
    type WorkspacePage,
    type WorkspacePageQuery,
    type WorkspaceList,
} from "./WorkspacePage.js";
import {
    workspaceTransferInputSchema,
    workspaceTransferResultSchema,
    workspaceTransferStoreResultSchema,
    type WorkspaceTransferInput,
    type WorkspaceTransferResult,
    type WorkspaceTransferStoreResult,
} from "./WorkspaceTransfer.js";
import { byOrder, lowestOrderKey, orderKeyBetween } from "./store/workspaceOrdering.js";
import {
    assertWorkspace,
    readProjectWorkspaces,
    readProjectWorkspacesFor,
    readWorkspace,
    readWorkspaceByPath,
    readWorkspacePage,
    sameJson,
    writeWorkspace,
} from "./store/workspaceRecords.js";
import { reserveWorkspace } from "./store/workspaceReservation.js";

export const workspaceMutationRequestSchema = Type.Object(
    {
        operation: workspaceMutationOperationSchema,
        operationId: workspaceOperationIdSchema,
    },
    { additionalProperties: false },
);

/**
 * The reservation the module hands the store. The module has already resolved the acting agent,
 * the project, the workspace kind, and whether the name was chosen deliberately; the store decides
 * the name, storage key, branch, path, and order that do not collide with anything.
 */
export const workspaceStoreReserveInputSchema = Type.Object(
    {
        id: workspaceIdSchema,
        ownerAgentId: workspaceAgentIdSchema,
        projectRef: workspaceProjectRefSchema,
        name: workspaceNameSchema,
        nameConfigured: Type.Boolean(),
        kind: workspaceKindSchema,
        baseRef: Type.Optional(workspaceBaseRefSchema),
        baseCommit: Type.Optional(workspaceCommitSchema),
        gitCommonDir: Type.Optional(workspaceGitCommonDirSchema),
        creatorSessionId: Type.Optional(workspaceSessionIdSchema),
        storageKeySeed: Type.Optional(workspaceStorageKeySchema),
    },
    { additionalProperties: false },
);

export const workspaceStoreRenameInputSchema = Type.Object(
    {
        workspaceId: workspaceIdSchema,
        name: workspaceNameSchema,
        expectedVersion: Type.Optional(workspaceVersionSchema),
    },
    { additionalProperties: false },
);

export const workspaceStoreInheritNameInputSchema = Type.Object(
    { workspaceId: workspaceIdSchema, name: workspaceNameSchema },
    { additionalProperties: false },
);

export const workspaceStoreSetBranchInputSchema = Type.Object(
    { workspaceId: workspaceIdSchema, branch: workspaceBranchSchema },
    { additionalProperties: false },
);

export const workspaceStoreRecordInitializationInputSchema = Type.Object(
    { workspaceId: workspaceIdSchema, facts: workspaceInitializationFactsSchema },
    { additionalProperties: false },
);

export const workspaceStoreWorkspaceInputSchema = Type.Object(
    { workspaceId: workspaceIdSchema },
    { additionalProperties: false },
);

export const workspaceStoreFailInputSchema = Type.Object(
    { workspaceId: workspaceIdSchema, error: workspaceErrorSchema },
    { additionalProperties: false },
);

export const workspaceStoreReorderInputSchema = Type.Object(
    {
        workspaceId: workspaceIdSchema,
        afterId: Type.Union([workspaceIdSchema, Type.Null()]),
        expectedVersion: Type.Optional(workspaceVersionSchema),
    },
    { additionalProperties: false },
);

export const workspaceStoreArchiveInputSchema = Type.Object(
    {
        workspaceId: workspaceIdSchema,
        expectedVersion: Type.Optional(workspaceVersionSchema),
    },
    { additionalProperties: false },
);

export const workspaceStoreApplyGitFactsInputSchema = Type.Object(
    { workspaceId: workspaceIdSchema, facts: workspaceGitFactsSchema },
    { additionalProperties: false },
);

export const workspaceStoreApplyProbeInputSchema = Type.Object(
    {
        workspaceId: workspaceIdSchema,
        presence: workspacePresenceSchema,
        facts: workspaceGitFactsSchema,
    },
    { additionalProperties: false },
);

/** One shape for every durable workspace mutation: what was asked, and the row it produced. */
export const workspaceMutationResultSchema = Type.Object(
    {
        agentId: workspaceAgentIdSchema,
        operationId: workspaceOperationIdSchema,
        operation: workspaceMutationOperationSchema,
        changed: Type.Boolean(),
        workspace: workspaceSchema,
    },
    { additionalProperties: false },
);

export const workspaceTransactionChangeSchema = Type.Object(
    {
        result: Type.Union([workspaceMutationResultSchema, workspaceTransferResultSchema]),
        event: Type.Optional(workspaceEventSchema),
    },
    { additionalProperties: false },
);

export const workspaceAuthorizationActionSchema = Type.Union([
    Type.Literal("list"),
    Type.Literal("get"),
    Type.Literal("branch_metadata"),
    Type.Literal("transfer"),
]);

/**
 * Missing authorization is an intentional deny for another owner's record.
 * Self access is granted by the module without invoking this policy.
 */
export const workspaceAuthorizationSchema = Type.Function(
    [
        workspaceContextSchema,
        workspaceAgentIdSchema,
        workspaceAgentIdSchema,
        workspaceAuthorizationActionSchema,
    ],
    Type.Union([Type.Boolean(), Type.Promise(Type.Boolean())]),
);

export type WorkspaceAuthorizationAction = Static<typeof workspaceAuthorizationActionSchema>;
export type WorkspaceAuthorization = Static<typeof workspaceAuthorizationSchema>;

/** Every durable mutation reads the same way: context, agent, what to change, and which call. */
const mutation = <TInput extends TSchema>(input: TInput) =>
    Type.Function(
        [workspaceContextSchema, workspaceAgentIdSchema, input, workspaceMutationRequestSchema],
        Type.Promise(workspaceMutationResultSchema),
    );

/**
 * This contract is private to the module-owned SQLite adapter. Callers
 * configure a narrow host operation service instead of injecting a store.
 */
export const workspaceStoreSchema = Type.Object(
    {
        reserve: Type.Function(
            [
                workspaceContextSchema,
                workspaceAgentIdSchema,
                workspaceStoreReserveInputSchema,
                workspaceReserveHooksSchema,
                workspaceMutationRequestSchema,
            ],
            Type.Promise(workspaceMutationResultSchema),
        ),
        list: Type.Function(
            [workspaceContextSchema, workspaceAgentIdSchema, workspacePageQuerySchema],
            Type.Promise(workspacePageSchema),
        ),
        get: Type.Function(
            [workspaceContextSchema, workspaceAgentIdSchema, workspaceIdSchema],
            Type.Promise(Type.Union([workspaceSchema, Type.Undefined()])),
        ),
        getByPath: Type.Function(
            [workspaceContextSchema, workspaceAgentIdSchema, workspacePathSchema],
            Type.Promise(Type.Union([workspaceSchema, Type.Undefined()])),
        ),
        rename: mutation(workspaceStoreRenameInputSchema),
        inheritName: mutation(workspaceStoreInheritNameInputSchema),
        setBranch: mutation(workspaceStoreSetBranchInputSchema),
        recordInitialization: mutation(workspaceStoreRecordInitializationInputSchema),
        markReady: mutation(workspaceStoreWorkspaceInputSchema),
        markFailed: mutation(workspaceStoreFailInputSchema),
        markInitializationFailed: mutation(workspaceStoreFailInputSchema),
        reorder: mutation(workspaceStoreReorderInputSchema),
        beginArchive: mutation(workspaceStoreArchiveInputSchema),
        completeArchive: mutation(workspaceStoreWorkspaceInputSchema),
        applyGitFacts: mutation(workspaceStoreApplyGitFactsInputSchema),
        applyProbe: mutation(workspaceStoreApplyProbeInputSchema),
        transfer: Type.Function(
            [
                workspaceContextSchema,
                workspaceAgentIdSchema,
                workspaceTransferInputSchema,
                workspaceMutationRequestSchema,
            ],
            Type.Promise(workspaceTransferStoreResultSchema),
        ),
        branchMetadata: Type.Function(
            [workspaceContextSchema, workspaceAgentIdSchema, workspaceIdSchema],
            Type.Promise(workspaceBranchMetadataSchema),
        ),
    },
    { additionalProperties: false },
);

export type WorkspaceStore = Static<typeof workspaceStoreSchema>;
export type WorkspaceStoreReserveInput = Static<typeof workspaceStoreReserveInputSchema>;
export type WorkspaceStoreRenameInput = Static<typeof workspaceStoreRenameInputSchema>;
export type WorkspaceStoreInheritNameInput = Static<typeof workspaceStoreInheritNameInputSchema>;
export type WorkspaceStoreSetBranchInput = Static<typeof workspaceStoreSetBranchInputSchema>;
export type WorkspaceStoreRecordInitializationInput = Static<
    typeof workspaceStoreRecordInitializationInputSchema
>;
export type WorkspaceStoreWorkspaceInput = Static<typeof workspaceStoreWorkspaceInputSchema>;
export type WorkspaceStoreFailInput = Static<typeof workspaceStoreFailInputSchema>;
export type WorkspaceStoreReorderInput = Static<typeof workspaceStoreReorderInputSchema>;
export type WorkspaceStoreArchiveInput = Static<typeof workspaceStoreArchiveInputSchema>;
export type WorkspaceStoreApplyGitFactsInput = Static<
    typeof workspaceStoreApplyGitFactsInputSchema
>;
export type WorkspaceStoreApplyProbeInput = Static<typeof workspaceStoreApplyProbeInputSchema>;
export type WorkspaceMutationRequest = Static<typeof workspaceMutationRequestSchema>;
export type WorkspaceMutationResult = Static<typeof workspaceMutationResultSchema>;
export type WorkspaceTransactionChange = Static<typeof workspaceTransactionChangeSchema>;

export type {
    Workspace,
    WorkspaceBranchMetadata,
    WorkspacePage,
    WorkspacePageQuery,
    WorkspaceTransferInput,
    WorkspaceTransferResult,
    WorkspaceTransferStoreResult,
};

export { orderKeyBetween, sameJson, workspaceMigrations, assertWorkspace };

export function assertWorkspaceStore(value: unknown): asserts value is WorkspaceStore {
    if (!Value.Check(workspaceStoreSchema, value)) {
        throw new Error("Workspace module received an invalid host store.");
    }
}

export function assertWorkspacePage(value: unknown): asserts value is WorkspacePage {
    if (!Value.Check(workspacePageSchema, value)) {
        throw new Error("Workspace store returned an invalid page.");
    }
}

export function assertWorkspaceList(value: unknown): asserts value is WorkspaceList {
    if (!Value.Check(workspaceListSchema, value)) {
        throw new Error("Workspace store returned an invalid workspace list.");
    }
}

export function assertWorkspaceBranchMetadata(
    value: unknown,
): asserts value is WorkspaceBranchMetadata {
    if (!Value.Check(workspaceBranchMetadataSchema, value)) {
        throw new Error("Workspace store returned invalid branch metadata.");
    }
}

export function assertWorkspaceMutationResult(
    value: unknown,
): asserts value is WorkspaceMutationResult {
    if (!Value.Check(workspaceMutationResultSchema, value)) {
        throw new Error("Workspace store returned an invalid mutation result.");
    }
}

export function assertWorkspaceTransferResult(
    value: unknown,
): asserts value is WorkspaceTransferResult {
    if (!Value.Check(workspaceTransferResultSchema, value)) {
        throw new Error("Workspace store returned an invalid transfer result.");
    }
}

export function assertWorkspaceTransactionChange(
    value: unknown,
): asserts value is WorkspaceTransactionChange {
    if (!Value.Check(workspaceTransactionChangeSchema, value)) {
        throw new Error("Workspace store transaction returned an invalid change.");
    }
}

/** What a host is told before it moves a workspace's Git branch. */
export const workspaceHostRenameBranchSchema = Type.Object(
    {
        workspaceId: workspaceIdSchema,
        path: workspacePathSchema,
        kind: workspaceKindSchema,
        name: workspaceNameSchema,
        branch: workspaceBranchSchema,
        previousBranch: workspaceBranchSchema,
    },
    { additionalProperties: false },
);

/** What a host is told before it removes a workspace's worktree or copied folder. */
export const workspaceHostArchiveSchema = Type.Object(
    {
        workspaceId: workspaceIdSchema,
        path: workspacePathSchema,
        kind: workspaceKindSchema,
        gitCommonDir: Type.Optional(workspaceGitCommonDirSchema),
    },
    { additionalProperties: false },
);

const workspaceHostAvailabilitySchema = Type.Union([
    Type.Boolean(),
    Type.Promise(Type.Boolean()),
]);

/**
 * The host's side of a workspace. Reservation stays inside the module — it is a durable decision
 * about names — but the host says which folders and branches are already spoken for, where a
 * workspace lives, and it performs the Git and filesystem work the durable record describes.
 *
 * The two availability answers are a real look at Git: a reservation refuses to invent a branch
 * when nothing can tell it which refs, loose or packed, already exist.
 */
export const workspaceHostSchema = Type.Object(
    {
        pathForStorageKey: Type.Optional(
            Type.Function(
                [workspaceProjectRefSchema, workspaceStorageKeySchema],
                workspacePathSchema,
            ),
        ),
        isBranchUnavailable: Type.Optional(
            Type.Function(
                [workspaceProjectRefSchema, workspaceBranchSchema],
                workspaceHostAvailabilitySchema,
            ),
        ),
        isStorageKeyUnavailable: Type.Optional(
            Type.Function(
                [workspaceProjectRefSchema, workspaceStorageKeySchema],
                workspaceHostAvailabilitySchema,
            ),
        ),
        renameBranch: Type.Optional(
            Type.Function(
                [
                    workspaceContextSchema,
                    workspaceAgentIdSchema,
                    workspaceHostRenameBranchSchema,
                    workspaceMutationRequestSchema,
                ],
                Type.Promise(Type.Union([workspaceBranchSchema, Type.Undefined()])),
            ),
        ),
        archive: Type.Optional(
            Type.Function(
                [
                    workspaceContextSchema,
                    workspaceAgentIdSchema,
                    workspaceHostArchiveSchema,
                    workspaceMutationRequestSchema,
                ],
                Type.Promise(Type.Void()),
            ),
        ),
        branchMetadata: Type.Optional(
            Type.Function(
                [workspaceContextSchema, workspaceAgentIdSchema, workspaceIdSchema],
                Type.Promise(workspaceBranchMetadataSchema),
            ),
        ),
        transfer: Type.Optional(
            Type.Function(
                [
                    workspaceContextSchema,
                    workspaceAgentIdSchema,
                    workspaceTransferInputSchema,
                    workspaceMutationRequestSchema,
                ],
                Type.Promise(workspaceTransferStoreResultSchema),
            ),
        ),
    },
    { additionalProperties: false },
);

export type WorkspaceHost = Static<typeof workspaceHostSchema>;
export type WorkspaceHostRenameBranch = Static<typeof workspaceHostRenameBranchSchema>;
export type WorkspaceHostArchive = Static<typeof workspaceHostArchiveSchema>;

export const workspaceStoreOptionsSchema = Type.Object(
    { host: Type.Optional(workspaceHostSchema) },
    { additionalProperties: false },
);

export type WorkspaceStoreOptions = Static<typeof workspaceStoreOptionsSchema>;

export function createWorkspaceStore(options: WorkspaceStoreOptions = {}): WorkspaceStore {
    if (!Value.Check(workspaceStoreOptionsSchema, options)) {
        throw new Error("Workspace store options are invalid.");
    }
    const host = options.host;

    /**
     * One durable write. The row the decision was read from is part of the update predicate, so a
     * mutation either applies to exactly that row or is refused, and the version it produces is
     * always the one after the version it read.
     */
    const update = async (
        ctx: Context,
        agentId: string,
        workspaceId: string,
        operation: WorkspaceMutationRequest,
        decide: (before: Workspace) => Workspace | undefined | Promise<Workspace | undefined>,
    ): Promise<WorkspaceMutationResult> => {
        const database = ctx.db;
        const before = await readWorkspace(database, workspaceId);
        if (before === undefined) throw new Error(`Workspace "${workspaceId}" was not found.`);
        const decided = await decide(before);
        if (decided === undefined) {
            return {
                agentId,
                operationId: operation.operationId,
                operation: operation.operation,
                changed: false,
                workspace: before,
            };
        }
        const workspace: Workspace = {
            ...decided,
            version: before.version + 1,
            updatedAt: Math.max(Date.now(), before.updatedAt + 1),
        };
        assertWorkspace(workspace);
        const stored = await writeWorkspace(database, workspace, before.version);
        return {
            agentId,
            operationId: operation.operationId,
            operation: operation.operation,
            changed: true,
            workspace: stored,
        };
    };

    return {
        reserve: async (ctx, actingAgentId, input, hooks, operation) =>
            await reserveWorkspace(ctx.db, actingAgentId, input, hooks, host, operation),

        list: async (ctx, _agentId, query) => {
            const cursor = query.cursor ?? 0;
            const limit = query.limit ?? 50;
            const rows = await readWorkspacePage(ctx.db, {
                projectRef: query.projectRef,
                includeArchived: query.includeArchived === true,
                cursor,
                limit,
            });
            const workspaces = rows.slice(0, limit);
            return {
                workspaces,
                cursor,
                ...(rows.length > limit ? { nextCursor: cursor + workspaces.length } : {}),
            };
        },

        get: async (ctx, _agentId, workspaceId) => await readWorkspace(ctx.db, workspaceId),

        getByPath: async (ctx, _agentId, path) => await readWorkspaceByPath(ctx.db, path),

        rename: async (ctx, actingAgentId, input, operation) => {
            const siblings = await readProjectWorkspacesFor(ctx.db, input.workspaceId);
            return await update(ctx, actingAgentId, input.workspaceId, operation, async (before) => {
                assertExpectedVersion(
                    before,
                    input.expectedVersion,
                    "The workspace changed before it could be renamed.",
                );
                if (isSettled(before)) return undefined;
                const named = await renameTo(before, input.name, siblings, host);
                // A person naming a workspace settles the question: a first chat never renames it
                // again, even when the name it chose happens to match.
                return named === undefined && before.nameConfigured
                    ? undefined
                    : { ...(named ?? before), nameConfigured: true };
            });
        },

        inheritName: async (ctx, actingAgentId, input, operation) => {
            const siblings = await readProjectWorkspacesFor(ctx.db, input.workspaceId);
            return await update(ctx, actingAgentId, input.workspaceId, operation, async (before) =>
                before.nameConfigured || isSettled(before)
                    ? undefined
                    : await renameTo(before, input.name, siblings, host),
            );
        },

        setBranch: async (ctx, actingAgentId, input, operation) =>
            await update(ctx, actingAgentId, input.workspaceId, operation, (before) =>
                isSettled(before) || before.branch === input.branch
                    ? undefined
                    : { ...before, branch: input.branch },
            ),

        recordInitialization: async (ctx, actingAgentId, input, operation) =>
            await update(ctx, actingAgentId, input.workspaceId, operation, (before) => {
                // A workspace archived or failed while Git discovery was running keeps its
                // terminal state and ignores the late result.
                if (before.status !== "initializing") return undefined;
                const next: Workspace = {
                    ...before,
                    baseCommit: input.facts.baseCommit,
                    baseRef: input.facts.baseRef,
                    gitCommonDir: input.facts.gitCommonDir,
                };
                return sameJson(next, before) ? undefined : next;
            }),

        markReady: async (ctx, actingAgentId, input, operation) =>
            await update(ctx, actingAgentId, input.workspaceId, operation, (before) => {
                if (before.status !== "initializing") return undefined;
                const next = { ...before, presence: "present" as const, status: "ready" as const };
                delete next.initializationError;
                return next;
            }),

        markFailed: async (ctx, actingAgentId, input, operation) =>
            await update(ctx, actingAgentId, input.workspaceId, operation, (before) =>
                before.status === "ready"
                    ? { ...before, status: "failed", initializationError: input.error }
                    : undefined,
            ),

        markInitializationFailed: async (ctx, actingAgentId, input, operation) =>
            await update(ctx, actingAgentId, input.workspaceId, operation, (before) =>
                before.status === "initializing"
                    ? {
                          ...before,
                          status: "failed",
                          initializationError: input.error,
                          initializationAttempt: Math.min(
                              before.initializationAttempt + 1,
                              1_000_000,
                          ),
                      }
                    : undefined,
            ),

        reorder: async (ctx, actingAgentId, input, operation) => {
            const database = ctx.db;
            if (input.afterId === input.workspaceId) {
                throw new Error("A workspace cannot be placed after itself.");
            }
            const target = await readWorkspace(database, input.workspaceId);
            if (target === undefined) {
                throw new Error(`Workspace "${input.workspaceId}" was not found.`);
            }
            const ordered = (await readProjectWorkspaces(database, target.projectRef))
                .filter((row) => row.id !== input.workspaceId)
                .sort(byOrder);
            const afterIndex =
                input.afterId === null
                    ? -1
                    : ordered.findIndex((row) => row.id === input.afterId);
            if (input.afterId !== null && afterIndex === -1) {
                throw new Error("The workspace to place after was not found in the project.");
            }
            const orderKey = orderKeyBetween(
                afterIndex === -1 ? null : (ordered[afterIndex]?.orderKey ?? null),
                ordered[afterIndex + 1]?.orderKey ?? null,
            );
            return await update(ctx, actingAgentId, input.workspaceId, operation, (before) => {
                assertExpectedVersion(
                    before,
                    input.expectedVersion,
                    "The workspace changed before it could be reordered.",
                );
                return before.orderKey === orderKey ? undefined : { ...before, orderKey };
            });
        },

        beginArchive: async (ctx, actingAgentId, input, operation) =>
            await update(ctx, actingAgentId, input.workspaceId, operation, (before) => {
                assertExpectedVersion(
                    before,
                    input.expectedVersion,
                    "The workspace changed before it could be archived.",
                );
                if (isSettled(before)) return undefined;
                const next: Workspace = { ...before, status: "archiving" };
                delete next.initializationError;
                return next;
            }),

        completeArchive: async (ctx, actingAgentId, input, operation) =>
            await update(ctx, actingAgentId, input.workspaceId, operation, (before) => {
                if (before.status !== "archiving") return undefined;
                const next: Workspace = {
                    ...before,
                    status: "archived",
                    archivedAt: Math.max(Date.now(), before.updatedAt + 1),
                };
                delete next.initializationError;
                return next;
            }),

        applyGitFacts: async (ctx, actingAgentId, input, operation) =>
            await update(ctx, actingAgentId, input.workspaceId, operation, (before) =>
                // Archival is the terminal decision. A scan that was already running when it was
                // made describes a workspace nobody has any more.
                isSettled(before) ? undefined : withGitFacts(before, input.facts),
            ),

        applyProbe: async (ctx, actingAgentId, input, operation) =>
            await update(ctx, actingAgentId, input.workspaceId, operation, (before) => {
                // A probe describes a workspace someone can use. Anything still being built or
                // taken down is described by its own lifecycle transition instead.
                if (before.status !== "ready") return undefined;
                const next = withGitFacts(before, input.facts) ?? before;
                const probed: Workspace = { ...next, presence: input.presence };
                return sameJson(probed, before) ? undefined : probed;
            }),

        transfer: async (ctx, actingAgentId, input, operation) => {
            const database = ctx.db;
            const hostResult =
                host?.transfer === undefined
                    ? undefined
                    : await host.transfer(ctx, actingAgentId, input, operation);
            const result =
                hostResult ??
                (await defaultWorkspaceTransfer(ctx, actingAgentId, input, operation));
            if (Value.Check(workspaceSchema, result)) {
                const current = await readWorkspace(database, result.id);
                if (current === undefined) {
                    throw new Error("Workspace transfer host returned a missing workspace.");
                }
                const stored = await writeWorkspace(
                    database,
                    { ...result, version: current.version + 1 },
                    current.version,
                );
                return {
                    agentId: actingAgentId,
                    operationId: operation.operationId,
                    changed: true,
                    state: "transferred",
                    workspace: {
                        id: stored.id,
                        projectRef: stored.projectRef,
                        ownerAgentId: stored.ownerAgentId,
                        path: stored.path,
                    },
                };
            }
            if (result.state === "transferred") {
                const current = await readWorkspace(database, result.workspace.id);
                if (current === undefined) {
                    throw new Error("Workspace transfer host returned a missing workspace.");
                }
                if (current.projectRef !== result.workspace.projectRef) {
                    await writeWorkspace(
                        database,
                        {
                            ...current,
                            projectRef: result.workspace.projectRef,
                            version: current.version + 1,
                            updatedAt: Math.max(Date.now(), current.updatedAt + 1),
                        },
                        current.version,
                    );
                }
            }
            return result;
        },

        branchMetadata: async (ctx, actingAgentId, workspaceId) => {
            if (host?.branchMetadata === undefined) {
                throw new Error("Workspace branch metadata requires an injected host service.");
            }
            return await host.branchMetadata(ctx, actingAgentId, workspaceId);
        },
    };
}

/** Archival is terminal: an observation that arrives afterwards changes nothing. */
function isSettled(workspace: Workspace): boolean {
    return workspace.status === "archiving" || workspace.status === "archived";
}

/**
 * Moves a workspace onto a name nothing else in the project answers to, and moves its branch with
 * it. Returns undefined when neither the name nor the branch would actually change.
 */
async function renameTo(
    before: Workspace,
    requested: string,
    siblings: readonly Workspace[],
    host: WorkspaceHost | undefined,
): Promise<Workspace | undefined> {
    const others = siblings.filter((row) => row.id !== before.id);
    const name = uniqueName(requested, (candidate) =>
        others.some((row) => workspaceNameKey(row.name) === workspaceNameKey(candidate)),
    );
    const branch = await uniqueBranch(workspaceBranchName(name), async (candidate) => {
        // A workspace never collides with itself: Git already holds the branch it is on, so a
        // name that slugs back to it must not be pushed onto a suffix for nothing.
        if (candidate === before.branch) return false;
        if (others.some((row) => row.branch === candidate)) return true;
        return host?.isBranchUnavailable === undefined
            ? false
            : await host.isBranchUnavailable(before.projectRef, candidate);
    });
    return name === before.name && branch === before.branch
        ? undefined
        : { ...before, name, branch };
}

function withGitFacts(before: Workspace, facts: WorkspaceGitFacts): Workspace | undefined {
    const next: Workspace = {
        ...before,
        ...(facts.branch === undefined ? {} : { branch: facts.branch }),
        gitAhead: facts.ahead,
        gitBehind: facts.behind,
        gitDetached: facts.detached,
    };
    if (facts.head === undefined) delete next.gitHead;
    else next.gitHead = facts.head;
    if (facts.upstream === undefined) delete next.gitUpstream;
    else next.gitUpstream = facts.upstream;
    return sameJson(next, before) ? undefined : next;
}

function assertExpectedVersion(
    workspace: Workspace,
    expectedVersion: number | undefined,
    message: string,
): void {
    if (expectedVersion !== undefined && workspace.version !== expectedVersion) {
        throw new Error(message);
    }
}

function uniqueName(base: string, taken: (candidate: string) => boolean): string {
    if (!taken(base)) return base;
    for (let suffix = 2; ; suffix += 1) {
        const candidate = `${base} (${String(suffix)})`;
        if (!taken(candidate)) return candidate;
    }
}

async function uniqueBranch(
    base: string,
    taken: (candidate: string) => Promise<boolean>,
): Promise<string> {
    if (!(await taken(base))) return base;
    for (let suffix = 2; ; suffix += 1) {
        const candidate = `${base}-${String(suffix)}`;
        if (!(await taken(candidate))) return candidate;
    }
}

async function defaultWorkspaceTransfer(
    ctx: Context,
    agentId: string,
    input: WorkspaceTransferInput,
    operation: WorkspaceMutationRequest,
): Promise<WorkspaceTransferResult> {
    const database = ctx.db;
    if ("targetWorkspaceId" in input) {
        const target = await readWorkspace(database, input.targetWorkspaceId);
        if (target === undefined) {
            throw new Error(`Workspace "${input.targetWorkspaceId}" was not found.`);
        }
        await writeWorkspace(
            database,
            {
                ...target,
                version: target.version + 1,
                updatedAt: Math.max(Date.now(), target.updatedAt + 1),
            },
            target.version,
        );
        return {
            agentId,
            operationId: operation.operationId,
            changed: true,
            state: "scheduled",
            targetWorkspaceId: input.targetWorkspaceId,
        };
    }
    const workspace = await readWorkspace(database, input.workspaceId);
    if (workspace === undefined) throw new Error(`Workspace "${input.workspaceId}" was not found.`);
    const changed = workspace.projectRef !== input.targetProjectRef;
    if (changed) {
        await writeWorkspace(
            database,
            {
                ...workspace,
                projectRef: input.targetProjectRef,
                version: workspace.version + 1,
                updatedAt: Math.max(Date.now(), workspace.updatedAt + 1),
            },
            workspace.version,
        );
    }
    return {
        agentId,
        operationId: operation.operationId,
        changed,
        state: "transferred",
        workspace: {
            id: workspace.id,
            projectRef: input.targetProjectRef,
            ownerAgentId: workspace.ownerAgentId,
            path: workspace.path,
        },
    };
}

export type { WorkspaceReserveHooks };
