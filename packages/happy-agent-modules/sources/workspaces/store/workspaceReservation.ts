import type { AgentDatabase } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";

import { workspacePathSchema, type Workspace, type WorkspaceReserveHooks } from "../Workspace.js";
import {
    workspaceBranchName,
    workspaceNameKey,
    workspaceStorageKey,
} from "../WorkspaceIdentity.js";
import type {
    WorkspaceHost,
    WorkspaceMutationRequest,
    WorkspaceMutationResult,
    WorkspaceStoreReserveInput,
} from "../WorkspaceStore.js";
import { lowestOrderKey, orderKeyBetween } from "./workspaceOrdering.js";
import {
    assertWorkspace,
    insertWorkspace,
    isUniquenessConflict,
    readProjectWorkspaces,
    readWorkspace,
} from "./workspaceRecords.js";

/**
 * How many times a reservation re-reads the project and picks again after another reservation took
 * the name it had chosen. Each attempt claims one more suffix, so a handful covers far more
 * simultaneous creations than a person can ask for.
 */
const RESERVATION_ATTEMPTS = 8;

/**
 * Reserves one workspace: a name, a folder key, a branch, and the folder they live in, written
 * before any Git or filesystem work starts.
 *
 * Two things make the reservation trustworthy. The names are chosen against the host's live view of
 * Git and the filesystem, and a reservation without that view fails rather than allocating a branch
 * nobody checked. And the choice is only provisional until the row is written: the unique indexes
 * decide the winner, and the loser picks again from a fresh snapshot instead of failing the person
 * who asked for it.
 *
 * The folder is recorded as missing. It becomes present when the host says it created it.
 */
export async function reserveWorkspace(
    database: AgentDatabase,
    actingAgentId: string,
    input: WorkspaceStoreReserveInput,
    hooks: WorkspaceReserveHooks,
    host: WorkspaceHost | undefined,
    operation: WorkspaceMutationRequest,
): Promise<WorkspaceMutationResult> {
    const unchanged = (workspace: Workspace): WorkspaceMutationResult => ({
        agentId: actingAgentId,
        operationId: operation.operationId,
        operation: operation.operation,
        changed: false,
        workspace,
    });

    const existing = await readWorkspace(database, input.id);
    if (existing !== undefined) {
        assertReservationStillMeans(existing, input);
        return unchanged(existing);
    }

    const probe = reservationProbe(input.projectRef, hooks, host);
    const seed = input.storageKeySeed ?? workspaceStorageKey(input.name);

    for (let attempt = 1; ; attempt += 1) {
        const siblings = await readProjectWorkspaces(database, input.projectRef);
        const name = uniqueName(input.name, (candidate) =>
            siblings.some((row) => workspaceNameKey(row.name) === workspaceNameKey(candidate)),
        );
        const storageKey = await uniqueKey(seed, async (candidate) => {
            if (
                siblings.some(
                    (row) =>
                        row.storageKey.toLocaleLowerCase("en-US") ===
                        candidate.toLocaleLowerCase("en-US"),
                )
            ) {
                return true;
            }
            return await probe.isStorageKeyUnavailable(candidate);
        });
        const branch = await uniqueKey(
            workspaceBranchName(input.storageKeySeed ?? name),
            async (candidate) => {
                if (siblings.some((row) => row.branch === candidate)) return true;
                return await probe.isBranchUnavailable(candidate);
            },
        );
        const path = probe.pathForStorageKey(storageKey);
        if (!Value.Check(workspacePathSchema, path)) {
            throw new Error(
                "A workspace folder must be an absolute path the host already normalized.",
            );
        }
        const at = Date.now();
        const workspace: Workspace = {
            id: input.id,
            ownerAgentId: input.ownerAgentId,
            projectRef: input.projectRef,
            name,
            nameConfigured: input.nameConfigured,
            branch,
            storageKey,
            kind: input.kind,
            path,
            ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
            ...(input.baseCommit === undefined ? {} : { baseCommit: input.baseCommit }),
            ...(input.gitCommonDir === undefined ? {} : { gitCommonDir: input.gitCommonDir }),
            // Nothing has been created yet. The host says when the folder is really there.
            presence: "missing",
            status: "initializing",
            // A new workspace goes to the top of the list; that is where the work just started.
            orderKey: orderKeyBetween(null, lowestOrderKey(siblings)),
            version: 1,
            ...(input.creatorSessionId === undefined
                ? {}
                : { creatorSessionId: input.creatorSessionId }),
            gitAhead: 0,
            gitBehind: 0,
            gitDetached: false,
            initializationAttempt: 1,
            createdAt: at,
            updatedAt: at,
        };
        assertWorkspace(workspace);
        try {
            await insertWorkspace(database, workspace);
        } catch (error: unknown) {
            if (!isUniquenessConflict(error)) throw error;
            // Someone else may have been this same reservation, retried.
            const raced = await readWorkspace(database, input.id);
            if (raced !== undefined) {
                assertReservationStillMeans(raced, input);
                return unchanged(raced);
            }
            if (attempt >= RESERVATION_ATTEMPTS) {
                throw new Error(
                    "Too many workspaces were created in this project at once. Try again.",
                );
            }
            continue;
        }
        return {
            agentId: actingAgentId,
            operationId: operation.operationId,
            operation: operation.operation,
            changed: true,
            workspace,
        };
    }
}

/**
 * A repeated reservation must describe the work the first one recorded. Everything the reservation
 * decided is compared, not only the project: a second call that means something else is a mistake
 * worth reporting rather than a silent alias for an unrelated workspace.
 */
export function assertReservationStillMeans(
    existing: Workspace,
    input: WorkspaceStoreReserveInput,
): void {
    if (existing.projectRef !== input.projectRef) {
        throw new Error("That workspace ID already names a workspace in another project.");
    }
    if (existing.ownerAgentId !== input.ownerAgentId) {
        throw new Error("That workspace ID already names a workspace owned by another agent.");
    }
    if (existing.kind !== input.kind) {
        throw new Error("That workspace ID already names a workspace of another kind.");
    }
    if (input.baseRef !== undefined && existing.baseRef !== input.baseRef) {
        throw new Error("That workspace ID already names a workspace with a different base.");
    }
    if (input.baseCommit !== undefined && existing.baseCommit !== input.baseCommit) {
        throw new Error("That workspace ID already names a workspace cut from a different commit.");
    }
    if (input.gitCommonDir !== undefined && existing.gitCommonDir !== input.gitCommonDir) {
        throw new Error("That workspace ID already names a workspace in another Git directory.");
    }
    if (
        input.creatorSessionId !== undefined &&
        existing.creatorSessionId !== input.creatorSessionId
    ) {
        throw new Error("That workspace ID already names a workspace created by another session.");
    }
    if (!answersTo(existing.name, input.name, (value) => workspaceNameKey(value))) {
        throw new Error("That workspace ID already names a workspace called something else.");
    }
    if (
        input.storageKeySeed !== undefined &&
        !answersTo(existing.storageKey, input.storageKeySeed, (value) =>
            value.toLocaleLowerCase("en-US"),
        )
    ) {
        throw new Error("That workspace ID already names a workspace in another folder.");
    }
}

/**
 * The host's three answers, or a clear refusal. A reservation cannot choose a branch or a folder
 * without them, so a missing probe stops the reservation rather than letting it guess.
 */
function reservationProbe(
    projectRef: string,
    hooks: WorkspaceReserveHooks,
    host: WorkspaceHost | undefined,
): {
    isBranchUnavailable: (branch: string) => Promise<boolean>;
    isStorageKeyUnavailable: (storageKey: string) => Promise<boolean>;
    pathForStorageKey: (storageKey: string) => string;
} {
    const branch = hooks.isBranchUnavailable;
    const storageKey = hooks.isStorageKeyUnavailable;
    const path = hooks.pathForStorageKey;
    const hostBranch = host?.isBranchUnavailable;
    const hostStorageKey = host?.isStorageKeyUnavailable;
    const hostPath = host?.pathForStorageKey;
    if (
        (branch === undefined && hostBranch === undefined) ||
        (storageKey === undefined && hostStorageKey === undefined) ||
        (path === undefined && hostPath === undefined)
    ) {
        throw new Error(
            "Reserving a workspace needs the host's view of Git and the filesystem: which " +
                "branches and folders are already taken, and where this workspace would live.",
        );
    }
    return {
        isBranchUnavailable: async (candidate) =>
            (branch === undefined ? false : await branch(candidate)) ||
            (hostBranch === undefined ? false : await hostBranch(projectRef, candidate)),
        isStorageKeyUnavailable: async (candidate) =>
            (storageKey === undefined ? false : await storageKey(candidate)) ||
            (hostStorageKey === undefined ? false : await hostStorageKey(projectRef, candidate)),
        pathForStorageKey: (candidate) =>
            path === undefined ? hostPath!(projectRef, candidate) : path(candidate),
    };
}

/**
 * Whether a stored value is the requested one. The first reservation may have moved onto a counted
 * suffix because something else already answered to the name, so the suffix a reservation adds is
 * still the same request.
 */
function answersTo(stored: string, requested: string, key: (value: string) => string): boolean {
    const requestedKey = key(requested);
    if (key(stored) === requestedKey) return true;
    return key(stored.replace(/ \(\d+\)$/u, "").replace(/-\d+$/u, "")) === requestedKey;
}

/**
 * Finds the first name nothing else in the project answers to.
 *
 * A name already in use gains a counted suffix rather than failing the request that asked for it.
 */
function uniqueName(base: string, taken: (candidate: string) => boolean): string {
    if (!taken(base)) return base;
    for (let suffix = 2; ; suffix += 1) {
        const candidate = `${base} (${String(suffix)})`;
        if (!taken(candidate)) return candidate;
    }
}

/** The same rule for the kebab-case values Git and the filesystem see. */
async function uniqueKey(
    base: string,
    taken: (candidate: string) => Promise<boolean>,
): Promise<string> {
    if (!(await taken(base))) return base;
    for (let suffix = 2; ; suffix += 1) {
        const candidate = `${base}-${String(suffix)}`;
        if (!(await taken(candidate))) return candidate;
    }
}
