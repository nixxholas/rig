import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";

import { createId } from "@paralleldrive/cuid2";
import sharp from "sharp";

import {
    createEventIdFactory,
    type CreateProjectWorkspaceRequest,
    type GitRepositoryFacts,
    type Project,
    type ProjectAvatarSource,
    type ProjectEvent,
    type ProjectWorkspace,
    type ProjectWorkspaceEvent,
    type ReorderRequest,
} from "../protocol/index.js";
import { errorToMessage } from "../errorToMessage.js";
import { clientChosenId } from "../utils/clientChosenId.js";
import { projectAvatarCollectGarbage } from "../persistence/project/projectAvatarCollectGarbage.js";
import { projectCreate } from "../persistence/project/projectCreate.js";
import { projectClearAvatar } from "../persistence/project/projectClearAvatar.js";
import { projectSetAvatar } from "../persistence/project/projectSetAvatar.js";
import { projectAdoptRemoteName } from "../persistence/project/projectAdoptRemoteName.js";
import { projectApplyGitFacts } from "../persistence/project/projectApplyGitFacts.js";
import { projectApplyProbe } from "../persistence/project/projectApplyProbe.js";
import { projectArchive } from "../persistence/project/projectArchive.js";
import { projectMarkInitializationFailed } from "../persistence/project/projectMarkInitializationFailed.js";
import { projectMarkInitializationReady } from "../persistence/project/projectMarkInitializationReady.js";
import { projectRefresh } from "../persistence/project/projectRefresh.js";
import { projectRename } from "../persistence/project/projectRename.js";
import { projectReorder } from "../persistence/project/projectReorder.js";
import { projectRestore } from "../persistence/project/projectRestore.js";
import { projectRetryInitialization } from "../persistence/project/projectRetryInitialization.js";
import { queryProject } from "../persistence/project/queryProject.js";
import { queryProjectAvatarAsset } from "../persistence/project/queryProjectAvatarAsset.js";
import { queryProjectAvatarGarbageCandidates } from "../persistence/project/queryProjectAvatarGarbageCandidates.js";
import { queryProjectByPath } from "../persistence/project/queryProjectByPath.js";
import { queryProjects } from "../persistence/project/queryProjects.js";
import { queryWorkspace } from "../persistence/project/queryWorkspace.js";
import { queryOwnedWorkspace } from "../persistence/project/queryOwnedWorkspace.js";
import { queryWorkspaceByPath } from "../persistence/project/queryWorkspaceByPath.js";
import { queryWorkspaceById } from "../persistence/project/queryWorkspaceById.js";
import { queryWorkspaces } from "../persistence/project/queryWorkspaces.js";
import { workspaceReserve } from "../persistence/project/workspaceReserve.js";
import { workspaceApplyGitFacts } from "../persistence/project/workspaceApplyGitFacts.js";
import { workspaceApplyProbe } from "../persistence/project/workspaceApplyProbe.js";
import { workspaceBeginArchive } from "../persistence/project/workspaceBeginArchive.js";
import { workspaceCompleteArchive } from "../persistence/project/workspaceCompleteArchive.js";
import { workspaceInheritTitle } from "../persistence/project/workspaceInheritTitle.js";
import { workspaceMarkInitializationFailed } from "../persistence/project/workspaceMarkInitializationFailed.js";
import { workspaceMarkReady } from "../persistence/project/workspaceMarkReady.js";
import { workspaceRename } from "../persistence/project/workspaceRename.js";
import { workspaceReorder } from "../persistence/project/workspaceReorder.js";
import { projectSetDefaultBranch } from "../persistence/project/projectSetDefaultBranch.js";
import { inTx } from "../persistence/inTx.js";
import { isDatabaseFailure } from "../persistence/isDatabaseFailure.js";
import type { TX } from "../persistence/Transaction.js";
import { normalizeProjectCwd } from "../utils/normalizeProjectCwd.js";
import { orderKeyAfter } from "../utils/orderKeyAfter.js";
import { createGitWorktree } from "../git/createGitWorktree.js";
import { detectGitDefaultBranch } from "../git/detectGitDefaultBranch.js";
import { isGitWorktreeAt } from "../git/isGitWorktreeAt.js";
import { parseHostingRepository } from "../git/parseHostingRepository.js";
import { type GitRepositoryProbe, probeGitRepository } from "../git/probeGitRepository.js";
import { readGitCommonDir } from "../git/readGitCommonDir.js";
import { readGitTopLevel } from "../git/readGitTopLevel.js";
import { remoteProjectName } from "../git/remoteProjectName.js";
import { removeGitWorktree } from "../git/removeGitWorktree.js";
import { resolveWorkspaceBase } from "../git/resolveWorkspaceBase.js";
import { runGitCommand } from "../git/runGitCommand.js";
import { runSandboxedGitCommand } from "../git/runSandboxedGitCommand.js";
import { selectGitRemoteUrl } from "../git/selectGitRemoteUrl.js";
import type { GitCommandRunner } from "../git/types.js";
import type { SessionDatabase } from "../persistence/database/openSessionDatabase.js";
import type { TaskDrain } from "../utils/TrackedTaskDrain.js";
import { folderProjectName, validateProjectName } from "./projectIdentity.js";
import { workspaceStorageKeysInUse } from "./workspaceStorageKeysInUse.js";
import { loadConfig } from "../config/loadConfig.js";
import { runWorkspaceSetupCommands } from "./runWorkspaceSetupCommands.js";

const AVATAR_GARBAGE_DELAY_MS = 24 * 60 * 60 * 1_000;
const GIT_PROBE_CONCURRENCY = 4;
const MAX_AVATAR_BYTES = 8 * 1024 * 1024;
const PROJECT_ERROR_LENGTH = 500;
const IMAGE_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"]);
const SKIPPED_DIRECTORIES = new Set([
    ".git",
    ".next",
    "build",
    "cache",
    "coverage",
    "dist",
    "node_modules",
    "target",
    "vendor",
]);

export interface ResolvedProjectOwnership {
    project: Project;
    workspace?: ProjectWorkspace;
}

export interface ProjectAvatarAsset {
    bytes: Buffer;
    hash: string;
    mediaType: "image/webp";
}

export interface ProjectRepositoryOptions {
    database: SessionDatabase;
    /** Replaces both Git execution surfaces at once, so a test can drive lifecycle without Git. */
    git?: GitCommandRunner;
    homeDirectory?: string;
    now?: () => number;
    /** Reports whether a project still has a session that would be stranded by removal. */
    onEvent?: (event: ProjectEvent | ProjectWorkspaceEvent) => void;
    /** Cleanup is best-effort after logical archival has already committed. */
    onWorkspaceCleanupError?: (error: unknown, projectId: string, workspaceId: string) => void;
    stateDirectory?: string;
    taskDrain?: TaskDrain;
    transaction?: <T>(body: (tx: TX) => T) => T;
    workspacesDirectory?: string;
}

export class ProjectRepository {
    readonly #assetRoot: string;
    readonly #avatarLifecycle = new Map<string, Promise<void>>();
    readonly #createEventId = createEventIdFactory();
    readonly #database: SessionDatabase;
    readonly #git: GitCommandRunner;
    /**
     * Background probes run unattended, so they read through the sandbox for the same reason live
     * scans do: a repository must not be able to make an unattended read execute a helper.
     */
    readonly #probeGit: GitCommandRunner;
    readonly #homeDirectory: string;
    readonly #initializing = new Set<string>();
    readonly #pendingInitializations: string[] = [];
    readonly #now: () => number;
    readonly #onEvent: ((event: ProjectEvent | ProjectWorkspaceEvent) => void) | undefined;
    readonly #onWorkspaceCleanupError:
        | ((error: unknown, projectId: string, workspaceId: string) => void)
        | undefined;
    readonly #stateDirectory: string;
    readonly #taskDrain: TaskDrain | undefined;
    readonly #transactionRunner: (<T>(body: (tx: TX) => T) => T) | undefined;
    readonly #workspacesDirectory: string;
    readonly #workspaceLifecycle = new Map<string, Promise<void>>();
    readonly #workspaceSetupControllers = new Map<string, AbortController>();
    #activeInitializations = 0;
    #closed = false;

    constructor(options: ProjectRepositoryOptions) {
        this.#database = options.database;
        this.#git = options.git ?? runGitCommand;
        this.#probeGit = options.git ?? runSandboxedGitCommand;
        this.#homeDirectory = normalizeProjectCwd(options.homeDirectory ?? homedir());
        this.#now = options.now ?? Date.now;
        this.#onEvent = options.onEvent;
        this.#onWorkspaceCleanupError = options.onWorkspaceCleanupError;
        this.#taskDrain = options.taskDrain;
        this.#transactionRunner = options.transaction;
        this.#stateDirectory = normalizeFuturePath(
            options.stateDirectory ??
                join(tmpdir(), `rig-projects-${String(process.pid)}-${createId()}`),
        );
        this.#workspacesDirectory = normalizeFuturePath(
            options.workspacesDirectory ?? join(this.#stateDirectory, "workspaces"),
        );
        this.#assetRoot = join(this.#stateDirectory, "assets", "project-avatars");
        setImmediate(() => {
            this.#runBackgroundTask(() => this.#collectAvatarGarbage());
        });
        for (const project of this.listProjects()) {
            if (project.kind === "regular" && project.initializationStatus === "initializing") {
                this.scheduleInitialization(project.id);
            } else if (
                project.kind === "regular" &&
                project.initializationStatus === "failed" &&
                project.initializationAttempt < 3 &&
                existsSync(project.path)
            ) {
                this.#mutate((tx) => {
                    const changed = projectRetryInitialization(tx, project.id, this.#now());
                    if (changed > 0) this.#publishedProject(project.id);
                });
                this.scheduleInitialization(project.id);
            }
        }
    }

    /**
     * Finds what owns a directory, importing the directory as a project if it is new.
     *
     * `requestedProjectId` names that import. A project is a folder, so a folder
     * Rig already knows keeps the identity it already has and the request is
     * simply answered with it; the identity only takes effect for a folder that
     * becomes a project now.
     */
    resolve(
        cwd: string,
        assertedWorkspaceId?: string,
        requestedProjectId?: string,
    ): ResolvedProjectOwnership {
        const path = normalizeProjectCwd(cwd);
        const workspace = queryWorkspaceByPath(this.#database, path);
        if (workspace !== undefined) {
            if (workspace.status !== "ready") {
                throw new Error(
                    `Workspace '${workspace.name}' is ${workspace.status.replaceAll("_", " ")}.`,
                );
            }
            if (assertedWorkspaceId !== undefined && assertedWorkspaceId !== workspace.id) {
                throw new Error("The workspace ID does not match the session directory.");
            }
            const project = this.getProject(workspace.projectId);
            if (project === undefined) throw new Error("The workspace project was not found.");
            return { project: this.unarchiveProject(project.id) ?? project, workspace };
        }
        if (assertedWorkspaceId !== undefined) {
            throw new Error("The workspace ID does not match the session directory.");
        }

        const importedId =
            requestedProjectId === undefined
                ? undefined
                : clientChosenId(requestedProjectId, "project");
        const existing = queryProjectByPath(this.#database, path);
        if (existing !== undefined) {
            /*
             * A project is only a folder, so working in it again is what brings it back: starting a
             * session restores an archived project instead of asking the user to unarchive it.
             */
            if (importedId !== undefined && importedId !== existing.id) {
                this.#assertUnusedProjectId(importedId, path);
            }
            return { project: this.unarchiveProject(existing.id) ?? existing };
        }
        if (importedId !== undefined) this.#assertUnusedProjectId(importedId, path);

        const kind = path === this.#homeDirectory ? "home" : "regular";
        const baseName = kind === "home" ? "Home" : folderProjectName(path);
        const now = this.#now();
        const id = importedId ?? createId();
        const project = this.#mutate((tx) => {
            projectCreate(tx, { baseName, id, kind, now, path });
            const created = this.getProject(id);
            if (created === undefined) throw new Error("The project could not be created.");
            this.#publishProject("project_created", created);
            return created;
        });
        if (kind === "regular") this.scheduleInitialization(id);
        return { project };
    }

    close(): void {
        this.#closed = true;
        this.#pendingInitializations.length = 0;
        for (const controller of this.#workspaceSetupControllers.values()) {
            controller.abort(new Error("Workspace setup stopped because Rig is closing."));
        }
        this.#workspaceSetupControllers.clear();
    }

    getProject(projectId: string): Project | undefined {
        return queryProject(this.#database, projectId);
    }

    listProjects(): readonly Project[] {
        return queryProjects(this.#database);
    }

    listWorkspaces(projectId?: string): readonly ProjectWorkspace[] {
        return queryWorkspaces(this.#database, projectId);
    }

    getWorkspace(projectId: string, workspaceId: string): ProjectWorkspace | undefined {
        return queryWorkspace(this.#database, projectId, workspaceId);
    }

    async reconcileInitializingWorkspaces(): Promise<void> {
        const workspaces = this.listWorkspaces().filter(
            (workspace) => workspace.status === "initializing",
        );
        for (const workspace of workspaces) {
            if (this.#closed) return;
            await this.#withWorkspaceLifecycleLock(workspace.id, () =>
                this.#reconcileInitializingWorkspace(workspace),
            );
        }
    }

    /**
     * Re-derives directory presence, worktree capability, and Git facts for every live project and
     * workspace. Enrichment only: it publishes when something actually changed, never blocks
     * startup, and stops as soon as the repository closes.
     */
    async reconcileGitFacts(): Promise<void> {
        const targets: (
            | { kind: "project"; value: Project }
            | { kind: "workspace"; value: ProjectWorkspace }
        )[] = [
            ...this.listProjects()
                // An archived project is hidden, so re-deriving its Git facts is wasted work.
                .filter((project) => project.archivedAt === undefined)
                .map((value) => ({ kind: "project" as const, value })),
            ...this.listWorkspaces()
                .filter((workspace) => workspace.status !== "archived")
                .map((value) => ({ kind: "workspace" as const, value })),
        ];
        let next = 0;
        const worker = async (): Promise<void> => {
            for (;;) {
                // The repository is closed only after the drain finishes, so checking that alone
                // would let this optional sweep keep claiming targets during shutdown and hold it
                // open for a Git timeout per remaining project.
                if (this.#closed || this.#taskDrain?.closing === true) return;
                const target = targets[next++];
                if (target === undefined) return;
                if (target.kind === "project") {
                    await this.#reconcileProjectGitFacts(target.value);
                } else {
                    await this.#reconcileWorkspaceGitFacts(target.value);
                }
            }
        };
        await Promise.all(
            Array.from({ length: Math.min(GIT_PROBE_CONCURRENCY, targets.length) }, worker),
        );
    }

    /**
     * Persists Git facts observed by a live scan.
     *
     * Branch, HEAD, and upstream are durable state, so a commit or a checkout has to reach clients
     * that are not watching the live stream. The change snapshot itself stays live-only; only these
     * few slow-moving fields are written, and only when one actually differs.
     */
    applyGitFacts(
        target: { projectId: string; workspaceId?: string },
        facts: GitRepositoryFacts,
    ): void {
        this.#mutate((tx) => {
            const changed =
                target.workspaceId === undefined
                    ? projectApplyGitFacts(tx, target.projectId, facts, this.#now())
                    : workspaceApplyGitFacts(
                          tx,
                          target.projectId,
                          target.workspaceId,
                          facts,
                          this.#now(),
                      );
            if (changed === 0) return;
            if (target.workspaceId === undefined) this.#publishedProject(target.projectId);
            else this.#publishedWorkspace(target.projectId, target.workspaceId);
        });
    }

    async #reconcileProjectGitFacts(project: Project): Promise<void> {
        const probe = await probeGitRepository({
            git: this.#probeGit,
            isHome: project.kind === "home",
            path: project.path,
        });
        if (this.#closed) return;
        this.#mutate((tx) => {
            const changed = projectApplyProbe(
                tx,
                project.id,
                projectGitFactValues(probe),
                this.#now(),
            );
            if (changed > 0) this.#publishedProject(project.id);
        });
    }

    async #reconcileWorkspaceGitFacts(workspace: ProjectWorkspace): Promise<void> {
        const probe = await probeGitRepository({
            git: this.#probeGit,
            path: workspace.path,
        });
        if (this.#closed) return;
        this.#mutate((tx) => {
            const changed = workspaceApplyProbe(
                tx,
                workspace.projectId,
                workspace.id,
                workspaceGitFactValues(probe),
                this.#now(),
            );
            if (changed > 0) this.#publishedWorkspace(workspace.projectId, workspace.id);
        });
    }

    renameProject(
        projectId: string,
        requestedName: string,
        expectedVersion?: number,
        mutationId?: string,
    ): Project | undefined {
        const current = this.getProject(projectId);
        if (current === undefined) return undefined;
        if (expectedVersion !== undefined && expectedVersion !== current.version) {
            throw new Error("The project changed before it could be renamed.");
        }
        const name = validateProjectName(requestedName);
        return this.#mutate((tx) => {
            const changed = projectRename(tx, projectId, name, this.#now(), expectedVersion);
            if (changed === 0) {
                if (expectedVersion !== undefined) {
                    throw new Error("The project changed before it could be renamed.");
                }
                return this.getProject(projectId);
            }
            return this.#publishedProject(projectId, mutationId);
        });
    }

    reorderProject(
        projectId: string,
        request: ReorderRequest,
        expectedVersion?: number,
    ): Project | undefined {
        const current = this.getProject(projectId);
        if (current === undefined) return undefined;
        if (expectedVersion !== undefined && expectedVersion !== current.version) {
            throw new Error("The project changed before it could be reordered.");
        }
        const orderKey = orderKeyAfter(this.listProjects(), projectId, request.afterId);
        if (orderKey === current.orderKey) return current;
        return this.#mutate((tx) => {
            const changed = projectReorder(tx, projectId, orderKey, this.#now(), expectedVersion);
            if (changed === 0) {
                if (expectedVersion !== undefined) {
                    throw new Error("The project changed before it could be reordered.");
                }
                return this.getProject(projectId);
            }
            return this.#publishedProject(projectId);
        });
    }

    refreshProject(projectId: string): Project | undefined {
        const project = this.getProject(projectId);
        if (project === undefined) return undefined;
        if (project.kind === "home") {
            throw new Error("The Home project does not need initialization.");
        }
        const updated = this.#mutate((tx) => {
            const changed = projectRefresh(tx, projectId, this.#now());
            return changed === 0 ? this.getProject(projectId) : this.#publishedProject(projectId);
        });
        this.scheduleInitialization(projectId);
        return updated;
    }

    scheduleInitialization(projectId: string): void {
        if (this.#closed || this.#initializing.has(projectId)) return;
        const project = this.getProject(projectId);
        if (project === undefined) return;
        if (!existsSync(project.path)) {
            this.#mutate((tx) => {
                const changed = projectMarkInitializationFailed(
                    tx,
                    projectId,
                    "Project directory is unavailable.",
                    this.#now(),
                );
                if (changed > 0) this.#publishedProject(projectId);
            });
            return;
        }
        this.#initializing.add(projectId);
        this.#pendingInitializations.push(projectId);
        setImmediate(() => this.#drainInitializations());
    }

    async setAvatar(
        projectId: string,
        source: ProjectAvatarSource,
        bytes: Buffer,
        expectedVersion?: number,
    ): Promise<Project | undefined> {
        const project = this.getProject(projectId);
        if (project === undefined) return undefined;
        if (expectedVersion !== undefined && expectedVersion !== project.version) {
            throw new Error("The project changed before the avatar could be saved.");
        }
        if (bytes.byteLength > MAX_AVATAR_BYTES) {
            throw new Error("The project avatar is larger than the allowed limit.");
        }
        const normalized = await normalizeAvatar(bytes);
        return this.#withAvatarLifecycleLock(normalized.hash, async () => {
            await this.#storeAvatarBytes(normalized.hash, normalized.bytes);
            if (this.#closed) return project;
            const now = this.#now();
            try {
                return this.#mutate((tx) => {
                    const result = projectSetAvatar(tx, {
                        asset: {
                            byteLength: normalized.bytes.byteLength,
                            hash: normalized.hash,
                            height: normalized.height,
                            width: normalized.width,
                        },
                        ...(expectedVersion === undefined ? {} : { expectedVersion }),
                        now,
                        projectId,
                        source,
                    });
                    if (result === "missing") return undefined;
                    if (result === "preserved") return this.getProject(projectId);
                    return this.#publishedProject(projectId);
                });
            } catch (error) {
                const asset = queryProjectAvatarAsset(this.#database, normalized.hash);
                if (asset === undefined) {
                    await rm(this.#avatarPath(normalized.hash), { force: true });
                }
                throw error;
            }
        });
    }

    clearAvatar(projectId: string): Project | undefined {
        const project = this.getProject(projectId);
        if (project === undefined) return undefined;
        const now = this.#now();
        const updated = this.#mutate((tx) => {
            const changed = projectClearAvatar(tx, projectId, now);
            return changed === 0 ? this.getProject(projectId) : this.#publishedProject(projectId);
        });
        if (updated?.kind === "regular") this.scheduleInitialization(projectId);
        return updated;
    }

    async avatarAsset(hash: string): Promise<ProjectAvatarAsset | undefined> {
        if (!/^[a-f0-9]{64}$/u.test(hash)) return undefined;
        const asset = queryProjectAvatarAsset(this.#database, hash);
        if (asset === undefined) return undefined;
        try {
            return {
                bytes: await readFile(this.#avatarPath(hash)),
                hash,
                mediaType: "image/webp",
            };
        } catch {
            return undefined;
        }
    }

    async createWorkspace(
        projectId: string,
        request: CreateProjectWorkspaceRequest,
        creatorSessionId?: string,
    ): Promise<ProjectWorkspace | undefined> {
        const project = this.getProject(projectId);
        if (project === undefined) return undefined;
        const name = validateProjectName(request.name);
        const requestedId =
            request.id === undefined ? undefined : clientChosenId(request.id, "workspace");
        const requestedRef = requestedBaseRef(request.baseRef);
        // A repeat that names its base can be answered from what is already stored. One that leaves
        // the base to the project cannot: the base has to be resolved before there is anything to
        // compare, so it falls through to the reservation, which rejects a genuine mismatch.
        const retry =
            requestedRef === undefined
                ? undefined
                : this.#retriedWorkspace(projectId, requestedId, requestedRef);
        if (retry !== undefined) return retry;

        const gitTopLevel = await readGitTopLevel(this.#git, project.path);
        if (gitTopLevel !== project.path) {
            throw new Error("Managed workspaces require a Git repository project.");
        }
        // A project added before its trunk was recorded, or one whose detection failed, learns the
        // branch now rather than forking whatever the project folder is checked out on.
        const defaultBranch =
            requestedRef === undefined ? await this.#projectDefaultBranch(project) : undefined;
        const gitCommonDir = await readGitCommonDir(this.#git, project.path);
        const base = await resolveWorkspaceBase({
            ...(defaultBranch === undefined ? {} : { defaultBranch }),
            git: this.#git,
            projectPath: project.path,
            ...(requestedRef === undefined ? {} : { requestedRef }),
        });
        const { commit } = base;
        const workspaceRoot = join(this.#workspacesDirectory, project.storageKey);
        const unavailableStorageKeys = await workspaceStorageKeysInUse({
            git: this.#git,
            projectPath: project.path,
            workspaceRoot,
        });

        const reservation = this.#mutate((tx) => {
            const result = workspaceReserve(tx, {
                baseCommit: commit,
                baseRef: base.ref,
                ...(creatorSessionId === undefined ? {} : { creatorSessionId }),
                gitCommonDir,
                id: requestedId ?? createId(),
                isStorageKeyUnavailable: (storageKey) =>
                    unavailableStorageKeys.has(storageKey.toLocaleLowerCase("en-US")),
                name,
                now: this.#now(),
                pathForStorageKey: (storageKey) => join(workspaceRoot, storageKey),
                projectId,
            });
            const workspace = this.getWorkspace(projectId, result.workspaceId);
            if (workspace === undefined) throw new Error("The workspace could not be reserved.");
            if (result.created) {
                this.#publishWorkspace("workspace_created", workspace, requestedId);
            }
            return { created: result.created, workspace };
        });
        const { workspace } = reservation;
        if (reservation.created) {
            setImmediate(() => {
                this.#runBackgroundTask(() =>
                    this.#materializeWorkspace(workspace, project.path, commit),
                );
            });
        }
        return workspace;
    }

    getOwnedWorkspace(
        creatorSessionId: string,
        projectId: string,
        workspaceId: string,
    ): ProjectWorkspace | undefined {
        return queryOwnedWorkspace(this.#database, creatorSessionId, projectId, workspaceId);
    }

    /** Refuses a client-chosen project identity that already names another folder. */
    #assertUnusedProjectId(id: string, path: string): void {
        const known = queryProject(this.#database, id);
        if (known !== undefined && known.path !== path) {
            throw new Error("That project ID already names another folder.");
        }
    }

    /**
     * The workspace a repeated create already made, if this is a repeat.
     *
     * The identity is the client's, so the same identity means the same
     * workspace and the request is simply answered again. An identity that
     * names a workspace somewhere else, or one built on another base, is a
     * different workspace wearing this one's name, and that is an error rather
     * than something to reconcile.
     */
    #retriedWorkspace(
        projectId: string,
        requestedId: string | undefined,
        baseRef: string,
    ): ProjectWorkspace | undefined {
        if (requestedId === undefined) return undefined;
        const workspace = queryWorkspaceById(this.#database, requestedId);
        if (workspace === undefined) return undefined;
        if (workspace.projectId !== projectId) {
            throw new Error("That workspace ID already names a workspace in another project.");
        }
        if (workspace.baseRef !== baseRef) {
            throw new Error("That workspace ID already names a workspace with a different base.");
        }
        return workspace;
    }

    renameWorkspace(
        projectId: string,
        workspaceId: string,
        requestedName: string,
        expectedVersion?: number,
        mutationId?: string,
    ): ProjectWorkspace | undefined {
        const current = this.getWorkspace(projectId, workspaceId);
        if (current === undefined) return undefined;
        if (expectedVersion !== undefined && expectedVersion !== current.version) {
            throw new Error("The workspace changed before it could be renamed.");
        }
        const name = validateProjectName(requestedName);
        return this.#mutate((tx) => {
            const changed = workspaceRename(
                tx,
                projectId,
                workspaceId,
                name,
                this.#now(),
                expectedVersion,
            );
            if (changed === 0) {
                if (expectedVersion !== undefined) {
                    throw new Error("The workspace changed before it could be renamed.");
                }
                return this.getWorkspace(projectId, workspaceId);
            }
            return this.#publishedWorkspace(projectId, workspaceId, mutationId);
        });
    }

    inheritWorkspaceTitle(
        projectId: string,
        workspaceId: string,
        title: string,
    ): ProjectWorkspace | undefined {
        const current = this.getWorkspace(projectId, workspaceId);
        if (current === undefined || current.title !== undefined) return current;
        return this.#mutate((tx) => {
            const changed = workspaceInheritTitle(tx, projectId, workspaceId, title, this.#now());
            return changed === 0
                ? this.getWorkspace(projectId, workspaceId)
                : this.#publishedWorkspace(projectId, workspaceId);
        });
    }

    reorderWorkspace(
        projectId: string,
        workspaceId: string,
        request: ReorderRequest,
        expectedVersion?: number,
    ): ProjectWorkspace | undefined {
        const current = this.getWorkspace(projectId, workspaceId);
        if (current === undefined) return undefined;
        if (expectedVersion !== undefined && expectedVersion !== current.version) {
            throw new Error("The workspace changed before it could be reordered.");
        }
        const orderKey = orderKeyAfter(
            this.listWorkspaces(projectId),
            workspaceId,
            request.afterId,
        );
        if (orderKey === current.orderKey) return current;
        return this.#mutate((tx) => {
            const changed = workspaceReorder(
                tx,
                projectId,
                workspaceId,
                orderKey,
                this.#now(),
                expectedVersion,
            );
            if (changed === 0) {
                if (expectedVersion !== undefined) {
                    throw new Error("The workspace changed before it could be reordered.");
                }
                return this.getWorkspace(projectId, workspaceId);
            }
            return this.#publishedWorkspace(projectId, workspaceId);
        });
    }

    archiveProject(projectId: string, expectedVersion?: number): Project | undefined {
        const project = this.getProject(projectId);
        if (project === undefined) return undefined;
        if (project.archivedAt !== undefined) return project;
        if (expectedVersion !== undefined && expectedVersion !== project.version) {
            throw new Error("The project changed before it could be archived.");
        }
        const now = this.#now();
        return this.#mutate((tx) => {
            const changed = projectArchive(tx, projectId, now, expectedVersion);
            if (changed === 0) {
                if (expectedVersion !== undefined) {
                    throw new Error("The project changed before it could be archived.");
                }
                return this.getProject(projectId);
            }
            return this.#publishedProject(projectId);
        });
    }

    unarchiveProject(projectId: string): Project | undefined {
        const project = this.getProject(projectId);
        if (project === undefined || project.archivedAt === undefined) return project;
        return this.#mutate((tx) => {
            const changed = projectRestore(tx, projectId, this.#now());
            return changed === 0 ? this.getProject(projectId) : this.#publishedProject(projectId);
        });
    }

    beginWorkspaceArchive(
        projectId: string,
        workspaceId: string,
        expectedVersion?: number,
    ): ProjectWorkspace | undefined {
        const workspace = this.getWorkspace(projectId, workspaceId);
        if (workspace === undefined) return undefined;
        if (workspace.status === "archived" || workspace.status === "archiving") {
            this.#stopWorkspaceSetup(workspaceId);
            return workspace;
        }
        if (expectedVersion !== undefined && expectedVersion !== workspace.version) {
            throw new Error("The workspace changed before it could be archived.");
        }
        const archived = this.#mutate((tx) => {
            const changed = workspaceBeginArchive(
                tx,
                projectId,
                workspaceId,
                this.#now(),
                expectedVersion,
            );
            if (changed === 0) {
                if (expectedVersion !== undefined) {
                    throw new Error("The workspace changed before it could be archived.");
                }
                return this.getWorkspace(projectId, workspaceId);
            }
            return this.#publishedWorkspace(projectId, workspaceId);
        });
        if (archived?.status === "archiving") this.#stopWorkspaceSetup(workspaceId);
        return archived;
    }

    async removeArchivedWorkspace(
        projectId: string,
        workspaceId: string,
    ): Promise<ProjectWorkspace | undefined> {
        await this.#withWorkspaceLifecycleLock(workspaceId, async () => {
            const workspace = this.getWorkspace(projectId, workspaceId);
            if (workspace === undefined || workspace.status === "archived") return;
            if (workspace.status !== "archiving") {
                throw new Error("The workspace is not being archived.");
            }
            const project = this.getProject(projectId);
            if (project === undefined) throw new Error("The workspace project was not found.");
            try {
                await this.#removeWorkspaceDirectory(project, workspace);
                if (this.#closed) return;
                this.#finishWorkspaceArchive(projectId, workspaceId, "archived");
            } catch (error) {
                if (isDatabaseFailure(error)) throw error;
                if (!this.#closed) {
                    this.#onWorkspaceCleanupError?.(error, projectId, workspaceId);
                    this.#finishWorkspaceArchive(projectId, workspaceId, "archived");
                }
            }
        });
        return this.getWorkspace(projectId, workspaceId);
    }

    /**
     * Reads the branch a project's workspaces are cut from, detecting and recording it on first
     * use so an older project or a failed detection still forks from the trunk.
     */
    async #projectDefaultBranch(project: Project): Promise<string | undefined> {
        if (project.defaultBranch !== undefined) return project.defaultBranch;
        const detected = await detectGitDefaultBranch(this.#git, project.path);
        if (detected === undefined || this.#closed) return detected;
        this.#mutate((tx) => {
            const changed = projectSetDefaultBranch(tx, project.id, detected, this.#now());
            if (changed > 0) this.#publishedProject(project.id);
        });
        // Another path may have recorded a different branch first. The stored decision is the one
        // the project publishes, so it is also the one the workspace has to be cut from.
        return this.getProject(project.id)?.defaultBranch ?? detected;
    }

    async #initialize(projectId: string): Promise<void> {
        if (this.#closed) return;
        const project = this.getProject(projectId);
        if (
            project === undefined ||
            project.kind === "home" ||
            project.initializationStatus !== "initializing"
        ) {
            return;
        }
        try {
            // A new project learns its presence and worktree capability here rather than waiting
            // for the next daemon start, because the desktop offers "Create worktree" immediately.
            await this.#reconcileProjectGitFacts(project);
            if (this.#closed) return;

            let remote: string | undefined;
            let repositoryTopLevel = false;
            try {
                repositoryTopLevel =
                    (await readGitTopLevel(this.#git, project.path)) === project.path;
                if (repositoryTopLevel) remote = await selectGitRemoteUrl(this.#git, project.path);
            } catch {
                // A regular non-Git directory is a valid project.
            }
            if (this.#closed) return;

            // The trunk is decided while the project is being added, so every later workspace has a
            // branch to fork without re-deciding it under a user's request. Git resolves upward
            // from a folder, so this waits until the folder is known to be a repository root and a
            // plain directory inside somebody else's repository cannot inherit their branch.
            if (repositoryTopLevel) await this.#projectDefaultBranch(project);
            if (this.#closed) return;

            const detectedName = remote === undefined ? undefined : remoteProjectName(remote);
            const current = this.getProject(projectId);
            if (current === undefined) return;
            if (detectedName !== undefined && current.nameSource === "folder") {
                this.#mutate((tx) => {
                    const changed = projectAdoptRemoteName(
                        tx,
                        projectId,
                        detectedName,
                        this.#now(),
                    );
                    if (changed > 0) this.#publishedProject(projectId);
                });
            }

            const beforeAvatar = this.getProject(projectId);
            if (beforeAvatar?.avatar === undefined) {
                const repositoryAvatar = repositoryTopLevel
                    ? await this.#findRepositoryAvatar(project.path)
                    : undefined;
                const hostingAvatar =
                    repositoryAvatar === undefined && remote !== undefined
                        ? await this.#findHostingAvatar(remote)
                        : undefined;
                const candidate = repositoryAvatar ?? hostingAvatar;
                if (this.#closed) return;
                if (candidate !== undefined && this.getProject(projectId)?.avatar === undefined) {
                    await this.setAvatar(
                        projectId,
                        repositoryAvatar === undefined ? "hosting" : "repository",
                        candidate,
                    );
                }
            }
            if (this.#closed) return;

            this.#mutate((tx) => {
                const changed = projectMarkInitializationReady(tx, projectId, this.#now());
                if (changed > 0) this.#publishedProject(projectId);
            });
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            if (this.#closed) return;
            this.#mutate((tx) => {
                const changed = projectMarkInitializationFailed(
                    tx,
                    projectId,
                    errorToMessage(error).slice(0, PROJECT_ERROR_LENGTH),
                    this.#now(),
                );
                if (changed > 0) this.#publishedProject(projectId);
            });
        }
    }

    #drainInitializations(): void {
        if (this.#closed) return;
        while (this.#activeInitializations < 2) {
            const projectId = this.#pendingInitializations.shift();
            if (projectId === undefined) return;
            this.#activeInitializations += 1;
            const initialize = () => this.#initialize(projectId);
            const task = this.#taskDrain?.run(initialize) ?? initialize();
            void task
                .finally(() => {
                    this.#activeInitializations -= 1;
                    this.#initializing.delete(projectId);
                    this.#drainInitializations();
                })
                .catch((error: unknown) => {
                    if (!isDatabaseFailure(error)) return;
                    setImmediate(() => {
                        throw error;
                    });
                });
        }
    }

    async #findRepositoryAvatar(root: string): Promise<Buffer | undefined> {
        const deadline = Date.now() + 2_000;
        const candidates: { path: string; score: number }[] = [];
        const directories = [
            root,
            ...[".github", "assets", "branding", "docs", "public", "resources", "static"].map(
                (directory) => join(root, directory),
            ),
            join(root, "src"),
        ];
        let inspected = 0;
        for (const directory of directories) {
            if (inspected >= 200 || Date.now() >= deadline) break;
            let entries;
            try {
                entries = await readdir(directory, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const entry of entries) {
                if (Date.now() >= deadline) break;
                inspected += 1;
                if (inspected > 200) break;
                if (entry.isSymbolicLink() || SKIPPED_DIRECTORIES.has(entry.name)) continue;
                if (entry.isDirectory() && directory === join(root, "src")) {
                    let children;
                    try {
                        children = await readdir(join(directory, entry.name), {
                            withFileTypes: true,
                        });
                    } catch {
                        continue;
                    }
                    for (const child of children) {
                        if (Date.now() >= deadline) break;
                        inspected += 1;
                        if (
                            inspected > 200 ||
                            !child.isFile() ||
                            child.isSymbolicLink() ||
                            !IMAGE_EXTENSIONS.has(extname(child.name).toLocaleLowerCase())
                        ) {
                            continue;
                        }
                        candidates.push({
                            path: join(directory, entry.name, child.name),
                            score: avatarCandidateScore(child.name, 2),
                        });
                    }
                    continue;
                }
                if (
                    !entry.isFile() ||
                    !IMAGE_EXTENSIONS.has(extname(entry.name).toLocaleLowerCase())
                ) {
                    continue;
                }
                candidates.push({
                    path: join(directory, entry.name),
                    score: avatarCandidateScore(entry.name, directory === root ? 0 : 1),
                });
            }
        }
        for (const candidate of candidates
            .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
            .slice(0, 32)) {
            if (Date.now() >= deadline) break;
            try {
                const info = await lstat(candidate.path);
                if (!info.isFile() || info.size > MAX_AVATAR_BYTES) continue;
                const bytes = await readFile(candidate.path);
                await normalizeAvatar(bytes);
                return bytes;
            } catch {
                // Try the next deterministic candidate.
            }
        }
        return undefined;
    }

    async #findHostingAvatar(remote: string): Promise<Buffer | undefined> {
        const repository = parseHostingRepository(remote);
        if (repository === undefined) return undefined;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2_000);
        timeout.unref?.();
        try {
            let apiUrl: URL;
            if (repository.host === "github.com") {
                apiUrl = new URL(
                    `https://api.github.com/users/${encodeURIComponent(repository.owner)}`,
                );
            } else if (repository.host === "gitlab.com") {
                apiUrl = new URL(
                    `https://gitlab.com/api/v4/projects/${encodeURIComponent(`${repository.owner}/${repository.repository}`)}`,
                );
            } else {
                apiUrl = new URL(
                    `https://api.bitbucket.org/2.0/repositories/${repository.owner
                        .split("/")
                        .map(encodeURIComponent)
                        .join("/")}/${encodeURIComponent(repository.repository)}`,
                );
            }
            const metadata = await fetch(apiUrl, {
                headers: { accept: "application/json", "user-agent": "Rig" },
                redirect: "error",
                signal: controller.signal,
            });
            if (!metadata.ok) return undefined;
            const metadataBytes = await readBoundedResponseBytes(metadata, 1_048_576, controller);
            const json = JSON.parse(metadataBytes.toString("utf8")) as Record<string, unknown>;
            const avatarUrl =
                repository.host === "bitbucket.org"
                    ? readNestedString(json, ["links", "avatar", "href"])
                    : typeof json.avatar_url === "string"
                      ? json.avatar_url
                      : undefined;
            if (avatarUrl === undefined) return undefined;
            const avatar = new URL(avatarUrl);
            const allowedHosts =
                repository.host === "github.com"
                    ? new Set(["avatars.githubusercontent.com"])
                    : repository.host === "gitlab.com"
                      ? new Set(["gitlab.com", "secure.gravatar.com"])
                      : new Set(["bitbucket.org", "secure.gravatar.com"]);
            if (avatar.protocol !== "https:" || !allowedHosts.has(avatar.hostname))
                return undefined;
            const response = await fetch(avatar, {
                headers: { accept: "image/*", "user-agent": "Rig" },
                redirect: "error",
                signal: controller.signal,
            });
            if (!response.ok || !response.headers.get("content-type")?.startsWith("image/")) {
                return undefined;
            }
            return await readBoundedResponseBytes(response, MAX_AVATAR_BYTES, controller);
        } catch {
            return undefined;
        } finally {
            clearTimeout(timeout);
        }
    }

    async #collectAvatarGarbage(): Promise<void> {
        if (this.#closed) return;
        const cutoff = this.#now() - AVATAR_GARBAGE_DELAY_MS;
        const hashes = queryProjectAvatarGarbageCandidates(this.#database, cutoff, 100);
        for (const hash of hashes) {
            if (this.#closed) return;
            await this.#withAvatarLifecycleLock(hash, async () => {
                if (this.#closed) return;
                const removed = this.#mutate((tx) => projectAvatarCollectGarbage(tx, hash, cutoff));
                if (removed) {
                    await rm(this.#avatarPath(hash), { force: true });
                }
            });
        }
    }

    async #reconcileInitializingWorkspace(workspace: ProjectWorkspace): Promise<void> {
        const current = this.getWorkspace(workspace.projectId, workspace.id);
        if (current?.status !== "initializing") return;
        const project = this.getProject(workspace.projectId);
        if (project === undefined) {
            this.#markWorkspaceInitializationFailed(
                workspace,
                "The workspace project was not found.",
            );
            return;
        }
        try {
            if (existsSync(workspace.path)) {
                const adoptable = await isGitWorktreeAt({
                    commonDir: workspace.gitCommonDir,
                    git: this.#git,
                    path: workspace.path,
                });
                if (adoptable) {
                    await this.#setupWorkspace(workspace);
                    if (this.#closed) return;
                    this.#markWorkspaceReady(workspace);
                    return;
                }
                // A partial managed worktree is cleaned up before retrying creation.
                await this.#removeWorkspaceDirectory(project, workspace);
            }
            if (this.#closed) return;
            // The workspace is anchored to the commit it was reserved on, so an interrupted
            // creation resumes onto exactly the base the workspace was promised, however far the
            // branch it came from has moved since.
            if (workspace.baseCommit === undefined) {
                throw new Error("The workspace base commit is unavailable.");
            }
            await this.#materializeWorkspaceLocked(workspace, project.path, workspace.baseCommit);
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            if (!this.#closed) {
                this.#markWorkspaceInitializationFailed(workspace, errorToMessage(error));
            }
        }
    }

    async #removeWorkspaceDirectory(project: Project, workspace: ProjectWorkspace): Promise<void> {
        const validStorageKey = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
        if (
            !validStorageKey.test(project.storageKey) ||
            !validStorageKey.test(workspace.storageKey)
        ) {
            throw new Error("The workspace storage identity is invalid.");
        }
        const workspacePath = normalizeFuturePath(workspace.path);
        if (
            workspace.path !== workspacePath ||
            basename(workspacePath) !== workspace.storageKey ||
            basename(dirname(workspacePath)) !== project.storageKey
        ) {
            throw new Error("The workspace path does not match its managed storage identity.");
        }

        let workspaceExists = true;
        try {
            const metadata = await lstat(workspace.path);
            if (metadata.isSymbolicLink()) {
                throw new Error("Refusing to archive a workspace path that is a symbolic link.");
            }
            if (!metadata.isDirectory()) {
                throw new Error("Refusing to archive a workspace path that is not a directory.");
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            workspaceExists = false;
        }
        if (this.#closed) return;

        if (existsSync(project.path)) {
            await removeGitWorktree({
                expectedCommonDir: workspace.gitCommonDir,
                git: this.#git,
                projectPath: project.path,
                removeDirectory: workspaceExists,
                workspacePath: workspace.path,
            });
            return;
        }

        if (existsSync(workspace.gitCommonDir)) {
            throw new Error(
                "The source project is unavailable while its Git common directory still exists.",
            );
        }
        if (workspaceExists) {
            await rm(workspace.path, { force: true, recursive: true });
        }
    }

    async #materializeWorkspace(
        workspace: ProjectWorkspace,
        projectPath: string,
        commit: string,
    ): Promise<void> {
        await this.#withWorkspaceLifecycleLock(workspace.id, () =>
            this.#materializeWorkspaceLocked(workspace, projectPath, commit),
        );
    }

    async #materializeWorkspaceLocked(
        workspace: ProjectWorkspace,
        projectPath: string,
        commit: string,
    ): Promise<void> {
        if (this.#closed) return;
        try {
            await createGitWorktree({
                branch: `worktree/${workspace.storageKey}`,
                commit,
                expectedCommonDir: workspace.gitCommonDir,
                git: this.#git,
                projectPath,
                workspacePath: workspace.path,
            });
            if (this.#closed) return;
            await this.#setupWorkspace(workspace);
            if (this.#closed) return;
            this.#markWorkspaceReady(workspace);
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            if (this.#closed) return;
            this.#markWorkspaceInitializationFailed(workspace, errorToMessage(error));
        }
    }

    async #setupWorkspace(workspace: ProjectWorkspace): Promise<void> {
        const controller = new AbortController();
        this.#workspaceSetupControllers.set(workspace.id, controller);
        try {
            if (this.getWorkspace(workspace.projectId, workspace.id)?.status !== "initializing") {
                return;
            }
            const loaded = await loadConfig({ cwd: workspace.path });
            await runWorkspaceSetupCommands(workspace.path, loaded.config.workspace.setupCommands, {
                signal: controller.signal,
            });
        } finally {
            if (this.#workspaceSetupControllers.get(workspace.id) === controller) {
                this.#workspaceSetupControllers.delete(workspace.id);
            }
        }
    }

    #stopWorkspaceSetup(workspaceId: string): void {
        this.#workspaceSetupControllers
            .get(workspaceId)
            ?.abort(new Error("Workspace setup stopped because the workspace was archived."));
    }

    #markWorkspaceReady(workspace: ProjectWorkspace): void {
        this.#mutate((tx) => {
            const changed = workspaceMarkReady(tx, workspace.projectId, workspace.id, this.#now());
            if (changed > 0) this.#publishedWorkspace(workspace.projectId, workspace.id);
        });
    }

    #markWorkspaceInitializationFailed(workspace: ProjectWorkspace, error: string): void {
        this.#mutate((tx) => {
            const changed = workspaceMarkInitializationFailed(
                tx,
                workspace.projectId,
                workspace.id,
                error.slice(0, PROJECT_ERROR_LENGTH),
                this.#now(),
            );
            if (changed > 0) this.#publishedWorkspace(workspace.projectId, workspace.id);
        });
    }

    #finishWorkspaceArchive(projectId: string, workspaceId: string, _status: "archived"): void {
        const now = this.#now();
        this.#mutate((tx) => {
            const changed = workspaceCompleteArchive(tx, projectId, workspaceId, now);
            if (changed > 0) this.#publishedWorkspace(projectId, workspaceId);
        });
    }

    #mutate<T>(body: (tx: TX) => T): T {
        if (this.#transactionRunner !== undefined) {
            return this.#transactionRunner(body);
        }
        return inTx(this.#database, body);
    }

    #runBackgroundTask(task: () => Promise<void>): void {
        if (this.#closed) return;
        const promise = this.#taskDrain?.run(task) ?? task();
        void promise.catch((error: unknown) => {
            if (!isDatabaseFailure(error)) return;
            setImmediate(() => {
                throw error;
            });
        });
    }

    async #withAvatarLifecycleLock<T>(hash: string, task: () => Promise<T>): Promise<T> {
        const previous = this.#avatarLifecycle.get(hash) ?? Promise.resolve();
        let release!: () => void;
        const barrier = new Promise<void>((resolveBarrier) => {
            release = resolveBarrier;
        });
        const queued = previous.catch(() => undefined).then(() => barrier);
        this.#avatarLifecycle.set(hash, queued);
        await previous.catch(() => undefined);
        try {
            return await task();
        } finally {
            release();
            if (this.#avatarLifecycle.get(hash) === queued) {
                this.#avatarLifecycle.delete(hash);
            }
        }
    }

    async #withWorkspaceLifecycleLock<T>(workspaceId: string, task: () => Promise<T>): Promise<T> {
        const previous = this.#workspaceLifecycle.get(workspaceId) ?? Promise.resolve();
        let release!: () => void;
        const barrier = new Promise<void>((resolveBarrier) => {
            release = resolveBarrier;
        });
        const queued = previous.catch(() => undefined).then(() => barrier);
        this.#workspaceLifecycle.set(workspaceId, queued);
        await previous.catch(() => undefined);
        try {
            return await task();
        } finally {
            release();
            if (this.#workspaceLifecycle.get(workspaceId) === queued) {
                this.#workspaceLifecycle.delete(workspaceId);
            }
        }
    }

    #publishedProject(projectId: string, mutationId?: string): Project | undefined {
        const project = this.getProject(projectId);
        if (project !== undefined) this.#publishProject("project_updated", project, mutationId);
        return project;
    }

    #publishedWorkspace(
        projectId: string,
        workspaceId: string,
        mutationId?: string,
    ): ProjectWorkspace | undefined {
        const workspace = this.getWorkspace(projectId, workspaceId);
        if (workspace !== undefined) {
            this.#publishWorkspace("workspace_updated", workspace, mutationId);
        }
        return workspace;
    }

    #publishProject(type: ProjectEvent["type"], project: Project, mutationId?: string): void {
        const event = {
            createdAt: this.#now(),
            data: { project, ...(mutationId === undefined ? {} : { mutationId }) },
            id: this.#createEventId(),
            projectId: project.id,
            type,
        } as ProjectEvent;
        this.#onEvent?.(event);
    }

    #publishWorkspace(
        type: ProjectWorkspaceEvent["type"],
        workspace: ProjectWorkspace,
        mutationId?: string,
    ): void {
        const event = {
            createdAt: this.#now(),
            data: { workspace, ...(mutationId === undefined ? {} : { mutationId }) },
            id: this.#createEventId(),
            projectId: workspace.projectId,
            type,
            workspaceId: workspace.id,
        } as ProjectWorkspaceEvent;
        this.#onEvent?.(event);
    }

    async #storeAvatarBytes(hash: string, bytes: Buffer): Promise<void> {
        const path = this.#avatarPath(hash);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const temporary = `${path}.${createId()}.tmp`;
        await writeFile(temporary, bytes, { mode: 0o600 });
        await rename(temporary, path).catch(async (error: unknown) => {
            await rm(temporary, { force: true });
            throw error;
        });
    }

    #avatarPath(hash: string): string {
        return join(this.#assetRoot, hash.slice(0, 2), `${hash}.webp`);
    }
}

async function readBoundedResponseBytes(
    response: Response,
    maximumBytes: number,
    controller: AbortController,
): Promise<Buffer> {
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
        controller.abort();
        throw new Error("The remote project image is too large.");
    }
    if (response.body === null) return Buffer.alloc(0);

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    try {
        for (;;) {
            const next = await reader.read();
            if (next.done) break;
            byteLength += next.value.byteLength;
            if (byteLength > maximumBytes) {
                controller.abort();
                await reader.cancel();
                throw new Error("The remote project image is too large.");
            }
            chunks.push(next.value);
        }
    } finally {
        reader.releaseLock();
    }
    return Buffer.concat(
        chunks.map((chunk) => Buffer.from(chunk)),
        byteLength,
    );
}

interface GitFactValues {
    gitAhead: number;
    gitBehind: number;
    gitBranch: string | null;
    gitDetached: boolean;
    gitHead: string | null;
    gitUpstream: string | null;
}

interface WorkspaceGitFactValues extends GitFactValues {
    presence: string;
}

interface ProjectGitFactValues extends WorkspaceGitFactValues {
    worktreeSupport: string;
    worktreeSupportReason: string | null;
}

/**
 * Validates an explicitly requested base reference.
 *
 * Most workspaces name no base at all and fork the project's trunk; a caller that does name one is
 * held to a reference Git can be handed safely.
 */
function requestedBaseRef(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    const baseRef = value.trim();
    if (baseRef.length === 0) return undefined;
    if (baseRef.length > 200 || baseRef.startsWith("-") || /[\p{Cc}\p{Cf}]/u.test(baseRef)) {
        throw new Error("The workspace base reference is invalid.");
    }
    return baseRef;
}

function gitFactValues(facts: GitRepositoryFacts): GitFactValues {
    return {
        gitAhead: facts.ahead,
        gitBehind: facts.behind,
        gitBranch: facts.branch ?? null,
        gitDetached: facts.detached,
        gitHead: facts.head ?? null,
        gitUpstream: facts.upstream ?? null,
    };
}

function workspaceGitFactValues(probe: GitRepositoryProbe): WorkspaceGitFactValues {
    return {
        ...gitFactValues(
            probe.facts ?? {
                ahead: 0,
                behind: 0,
                detached: false,
            },
        ),
        presence: probe.presence,
    };
}

function projectGitFactValues(probe: GitRepositoryProbe): ProjectGitFactValues {
    return {
        ...workspaceGitFactValues(probe),
        worktreeSupport: probe.worktreeSupport,
        worktreeSupportReason: probe.worktreeSupportReason ?? null,
    };
}

function avatarCandidateScore(name: string, depth: number): number {
    const stem = basename(name, extname(name)).toLocaleLowerCase("en-US");
    const preferred = ["logo", "icon", "app-icon", "appicon", "brand"];
    const index = preferred.indexOf(stem);
    let score = index === -1 ? 0 : 100 - index * 10;
    score -= depth * 10;
    if (/(?:wordmark|banner|screenshot|badge|favicon|dark|light)/u.test(stem)) score -= 60;
    return score;
}

async function normalizeAvatar(
    bytes: Buffer,
): Promise<{ bytes: Buffer; hash: string; height: number; width: number }> {
    const image = sharp(bytes, {
        animated: false,
        failOn: "error",
        limitInputPixels: 25_000_000,
    }).rotate();
    const metadata = await image.metadata();
    if (metadata.width === undefined || metadata.height === undefined) {
        throw new Error("The project avatar does not contain a readable image.");
    }
    const result = await image
        .resize({
            fit: "inside",
            height: 256,
            kernel: "lanczos3",
            width: 256,
            withoutEnlargement: true,
        })
        .webp({ quality: 82 })
        .toBuffer({ resolveWithObject: true });
    return {
        bytes: result.data,
        hash: createHash("sha256").update(result.data).digest("hex"),
        height: result.info.height,
        width: result.info.width,
    };
}

function readNestedString(
    value: Record<string, unknown>,
    path: readonly string[],
): string | undefined {
    let current: unknown = value;
    for (const key of path) {
        if (current === null || typeof current !== "object" || Array.isArray(current)) {
            return undefined;
        }
        current = (current as Record<string, unknown>)[key];
    }
    return typeof current === "string" ? current : undefined;
}

function normalizeFuturePath(path: string): string {
    const missingSegments: string[] = [];
    let existingAncestor = resolve(path);
    while (!existsSync(existingAncestor)) {
        const parent = dirname(existingAncestor);
        if (parent === existingAncestor) break;
        missingSegments.unshift(basename(existingAncestor));
        existingAncestor = parent;
    }
    return resolve(normalizeProjectCwd(existingAncestor), ...missingSegments);
}
