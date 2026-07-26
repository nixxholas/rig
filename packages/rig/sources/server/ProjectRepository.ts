import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { DatabaseSync } from "node:sqlite";

import { createId } from "@paralleldrive/cuid2";
import sharp from "sharp";

import {
    createEventIdFactory,
    type CreateProjectWorkspaceRequest,
    type GitRepositoryFacts,
    type Project,
    type ProjectAvatar,
    type ProjectAvatarSource,
    type ProjectEvent,
    type ProjectWorkspace,
    type ProjectWorkspaceEvent,
    type ReorderRequest,
} from "../protocol/index.js";
import { errorToMessage } from "../errorToMessage.js";
import { generateKeyBetween } from "../utils/fractionalIndexing.js";
import { orderKeyAfter } from "../utils/orderKeyAfter.js";
import { normalizeProjectCwd } from "./normalizeProjectCwd.js";
import { type GitRepositoryProbe, probeGitRepository } from "./probeGitRepository.js";
import type { TaskDrain } from "./TrackedTaskDrain.js";
import {
    folderProjectName,
    parseHostingRepository,
    projectNameKey,
    projectStorageKey,
    remoteProjectName,
    validateProjectName,
} from "./projectIdentity.js";

const execFile = promisify(execFileCallback);
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

export type ProjectGitRunner = (cwd: string, args: readonly string[]) => Promise<string>;

export interface ProjectRepositoryOptions {
    database: DatabaseSync;
    git?: ProjectGitRunner;
    homeDirectory?: string;
    now?: () => number;
    onEvent?: (event: ProjectEvent | ProjectWorkspaceEvent) => void;
    stateDirectory?: string;
    taskDrain?: TaskDrain;
    transaction?: <T>(body: () => T) => T;
}

export class ProjectRepository {
    readonly #assetRoot: string;
    readonly #avatarLifecycle = new Map<string, Promise<void>>();
    readonly #createEventId = createEventIdFactory();
    readonly #database: DatabaseSync;
    readonly #gitRunner: ProjectGitRunner;
    readonly #homeDirectory: string;
    readonly #initializing = new Set<string>();
    readonly #pendingInitializations: string[] = [];
    readonly #now: () => number;
    readonly #onEvent: ((event: ProjectEvent | ProjectWorkspaceEvent) => void) | undefined;
    readonly #stateDirectory: string;
    readonly #taskDrain: TaskDrain | undefined;
    readonly #transactionRunner: (<T>(body: () => T) => T) | undefined;
    readonly #workspaceLifecycle = new Map<string, Promise<void>>();
    #activeInitializations = 0;
    #closed = false;

    constructor(options: ProjectRepositoryOptions) {
        this.#database = options.database;
        this.#gitRunner = options.git ?? runGit;
        this.#homeDirectory = normalizeProjectCwd(options.homeDirectory ?? homedir());
        this.#now = options.now ?? Date.now;
        this.#onEvent = options.onEvent;
        this.#taskDrain = options.taskDrain;
        this.#transactionRunner = options.transaction;
        this.#stateDirectory = normalizeFuturePath(
            options.stateDirectory ??
                join(tmpdir(), `rig-projects-${String(process.pid)}-${createId()}`),
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
                this.#transaction(() => {
                    this.#database
                        .prepare(
                            `
                            UPDATE projects
                            SET initialization_status = 'initializing',
                                initialization_error = NULL,
                                version = version + 1, updated_at_ms = ?
                            WHERE id = ? AND initialization_status = 'failed'
                            `,
                        )
                        .run(this.#now(), project.id);
                    this.#publishedProject(project.id);
                });
                this.scheduleInitialization(project.id);
            }
        }
    }

    resolve(cwd: string, assertedWorkspaceId?: string): ResolvedProjectOwnership {
        const path = normalizeProjectCwd(cwd);
        const workspaceRow = this.#database
            .prepare("SELECT * FROM project_workspaces WHERE path = ?")
            .get(path);
        if (workspaceRow !== undefined) {
            const workspace = readWorkspace(workspaceRow);
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

        const existing = this.#database.prepare("SELECT * FROM projects WHERE path = ?").get(path);
        if (existing !== undefined) {
            /*
             * A project is only a folder, so working in it again is what brings it back: starting a
             * session restores an archived project instead of asking the user to unarchive it.
             */
            const project = readProject(existing);
            return { project: this.unarchiveProject(project.id) ?? project };
        }

        const kind = path === this.#homeDirectory ? "home" : "regular";
        const baseName = kind === "home" ? "Home" : folderProjectName(path);
        const name = this.#reserveProjectName(baseName);
        const storageKey = this.#reserveProjectStorageKey(
            kind === "home" ? "home" : projectStorageKey(folderProjectName(path)),
        );
        const now = this.#now();
        const id = createId();
        const project = this.#transaction(() => {
            this.#database
                .prepare(
                    `
                    INSERT INTO projects (
                        id, path, storage_key, kind, name, name_key, name_source, order_key,
                        initialization_status, initialization_attempt, version,
                        created_at_ms, updated_at_ms
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)
                    `,
                )
                .run(
                    id,
                    path,
                    storageKey,
                    kind,
                    name,
                    projectNameKey(name),
                    "folder",
                    this.#newFirstProjectOrderKey(),
                    kind === "home" ? "ready" : "initializing",
                    now,
                    now,
                );
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
    }

    getProject(projectId: string): Project | undefined {
        const row = this.#database.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
        return row === undefined ? undefined : this.#readProject(row);
    }

    listProjects(): readonly Project[] {
        return this.#database
            .prepare("SELECT * FROM projects ORDER BY order_key ASC, id ASC")
            .all()
            .map((row) => this.#readProject(row));
    }

    listWorkspaces(projectId?: string): readonly ProjectWorkspace[] {
        const rows =
            projectId === undefined
                ? this.#database
                      .prepare(
                          `
                          SELECT project_workspaces.*
                          FROM project_workspaces
                          JOIN projects ON projects.id = project_workspaces.project_id
                          ORDER BY projects.order_key ASC, project_workspaces.order_key ASC,
                              project_workspaces.id ASC
                          `,
                      )
                      .all()
                : this.#database
                      .prepare(
                          "SELECT * FROM project_workspaces WHERE project_id = ? ORDER BY order_key ASC, id ASC",
                      )
                      .all(projectId);
        return rows.map(readWorkspace);
    }

    getWorkspace(projectId: string, workspaceId: string): ProjectWorkspace | undefined {
        const row = this.#database
            .prepare("SELECT * FROM project_workspaces WHERE id = ? AND project_id = ?")
            .get(workspaceId, projectId);
        return row === undefined ? undefined : readWorkspace(row);
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
                if (this.#closed) return;
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
        const bindings = [
            facts.branch ?? null,
            facts.head ?? null,
            facts.upstream ?? null,
            facts.ahead,
            facts.behind,
            facts.detached ? 1 : 0,
        ];
        this.#transaction(() => {
            const isWorkspace = target.workspaceId !== undefined;
            const result = this.#database
                .prepare(
                    isWorkspace
                        ? `
                        UPDATE project_workspaces
                        SET git_branch = ?, git_head = ?, git_upstream = ?,
                            git_ahead = ?, git_behind = ?, git_detached = ?,
                            version = version + 1, updated_at_ms = ?
                        WHERE id = ? AND (
                            git_branch IS NOT ? OR git_head IS NOT ? OR git_upstream IS NOT ?
                            OR git_ahead IS NOT ? OR git_behind IS NOT ? OR git_detached IS NOT ?
                        )
                        `
                        : `
                        UPDATE projects
                        SET git_branch = ?, git_head = ?, git_upstream = ?,
                            git_ahead = ?, git_behind = ?, git_detached = ?,
                            version = version + 1, updated_at_ms = ?
                        WHERE id = ? AND removed_at_ms IS NULL AND (
                            git_branch IS NOT ? OR git_head IS NOT ? OR git_upstream IS NOT ?
                            OR git_ahead IS NOT ? OR git_behind IS NOT ? OR git_detached IS NOT ?
                        )
                        `,
                )
                .run(
                    ...bindings,
                    this.#now(),
                    isWorkspace ? target.workspaceId! : target.projectId,
                    ...bindings,
                );
            if (result.changes === 0) return;
            if (isWorkspace) {
                this.#publishedWorkspace(target.projectId, target.workspaceId!);
            } else {
                this.#publishedProject(target.projectId);
            }
        });
    }

    async #reconcileProjectGitFacts(project: Project): Promise<void> {
        const probe = await probeGitRepository({
            git: (cwd, args) => this.#git(cwd, args),
            isHome: project.kind === "home",
            path: project.path,
        });
        if (this.#closed) return;
        this.#transaction(() => {
            const result = this.#database
                .prepare(
                    `
                    UPDATE projects
                    SET presence = ?, worktree_support = ?, worktree_support_reason = ?,
                        git_branch = ?, git_head = ?, git_upstream = ?,
                        git_ahead = ?, git_behind = ?, git_detached = ?,
                        version = version + 1, updated_at_ms = ?
                    WHERE id = ? AND archived_at_ms IS NULL AND (
                        presence IS NOT ? OR worktree_support IS NOT ?
                        OR worktree_support_reason IS NOT ? OR git_branch IS NOT ?
                        OR git_head IS NOT ? OR git_upstream IS NOT ?
                        OR git_ahead IS NOT ? OR git_behind IS NOT ? OR git_detached IS NOT ?
                    )
                    `,
                )
                .run(...gitFactBindings(probe), this.#now(), project.id, ...gitFactBindings(probe));
            if (result.changes > 0) this.#publishedProject(project.id);
        });
    }

    async #reconcileWorkspaceGitFacts(workspace: ProjectWorkspace): Promise<void> {
        const probe = await probeGitRepository({
            git: (cwd, args) => this.#git(cwd, args),
            path: workspace.path,
        });
        if (this.#closed) return;
        this.#transaction(() => {
            const result = this.#database
                .prepare(
                    `
                    UPDATE project_workspaces
                    SET presence = ?, git_branch = ?, git_head = ?, git_upstream = ?,
                        git_ahead = ?, git_behind = ?, git_detached = ?,
                        version = version + 1, updated_at_ms = ?
                    WHERE id = ? AND (
                        presence IS NOT ? OR git_branch IS NOT ? OR git_head IS NOT ?
                        OR git_upstream IS NOT ? OR git_ahead IS NOT ?
                        OR git_behind IS NOT ? OR git_detached IS NOT ?
                    )
                    `,
                )
                .run(
                    ...workspaceGitFactBindings(probe),
                    this.#now(),
                    workspace.id,
                    ...workspaceGitFactBindings(probe),
                );
            if (result.changes > 0) {
                this.#publishedWorkspace(workspace.projectId, workspace.id);
            }
        });
    }

    renameProject(projectId: string, requestedName: string): Project | undefined {
        const current = this.getProject(projectId);
        if (current === undefined) return undefined;
        const name = this.#reserveProjectName(validateProjectName(requestedName), projectId);
        return this.#transaction(() => {
            this.#database
                .prepare(
                    `
                    UPDATE projects
                    SET name = ?, name_key = ?, name_source = 'user',
                        version = version + 1, updated_at_ms = ?
                    WHERE id = ?
                    `,
                )
                .run(name, projectNameKey(name), this.#now(), projectId);
            return this.#publishedProject(projectId);
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
        return this.#transaction(() => {
            this.#database
                .prepare(
                    `
                    UPDATE projects
                    SET order_key = ?, version = version + 1, updated_at_ms = ?
                    WHERE id = ?
                    `,
                )
                .run(orderKey, this.#now(), projectId);
            return this.#publishedProject(projectId);
        });
    }

    refreshProject(projectId: string): Project | undefined {
        const project = this.getProject(projectId);
        if (project === undefined) return undefined;
        if (project.kind === "home") {
            throw new Error("The Home project does not need initialization.");
        }
        const updated = this.#transaction(() => {
            this.#database
                .prepare(
                    `
                    UPDATE projects
                    SET initialization_status = 'initializing', initialization_error = NULL,
                        initialization_attempt = initialization_attempt + 1,
                        version = version + 1, updated_at_ms = ?
                    WHERE id = ?
                    `,
                )
                .run(this.#now(), projectId);
            return this.#publishedProject(projectId);
        });
        this.scheduleInitialization(projectId);
        return updated;
    }

    scheduleInitialization(projectId: string): void {
        if (this.#closed || this.#initializing.has(projectId)) return;
        const project = this.getProject(projectId);
        if (project === undefined) return;
        if (!existsSync(project.path)) {
            this.#transaction(() => {
                this.#database
                    .prepare(
                        `
                        UPDATE projects
                        SET initialization_status = 'failed',
                            initialization_error = 'Project directory is unavailable.',
                            initialization_attempt = initialization_attempt + 1,
                            version = version + 1, updated_at_ms = ?
                        WHERE id = ? AND initialization_status = 'initializing'
                        `,
                    )
                    .run(this.#now(), projectId);
                this.#publishedProject(projectId);
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
                return this.#transaction(() => {
                    const latest = this.#database
                        .prepare(
                            "SELECT version, avatar_hash, avatar_source FROM projects WHERE id = ?",
                        )
                        .get(projectId);
                    if (latest === undefined) return undefined;
                    if (
                        expectedVersion !== undefined &&
                        readNumber(latest, "version") !== expectedVersion
                    ) {
                        throw new Error("The project changed before the avatar could be saved.");
                    }
                    if (
                        source !== "user" &&
                        readOptionalString(latest, "avatar_source") === "user"
                    ) {
                        return this.getProject(projectId);
                    }
                    const previousHash = readOptionalString(latest, "avatar_hash");
                    this.#database
                        .prepare(
                            `
                            INSERT INTO project_avatar_assets (
                                hash, media_type, byte_length, width, height, created_at_ms,
                                dereferenced_at_ms
                            ) VALUES (?, 'image/webp', ?, ?, ?, ?, NULL)
                            ON CONFLICT(hash) DO UPDATE SET dereferenced_at_ms = NULL
                            `,
                        )
                        .run(
                            normalized.hash,
                            normalized.bytes.byteLength,
                            normalized.width,
                            normalized.height,
                            now,
                        );
                    this.#database
                        .prepare(
                            `
                            UPDATE projects
                            SET avatar_hash = ?, avatar_source = ?,
                                version = version + 1, updated_at_ms = ?
                            WHERE id = ?
                            `,
                        )
                        .run(normalized.hash, source, now, projectId);
                    if (previousHash !== undefined && previousHash !== normalized.hash) {
                        this.#dereferenceAvatar(previousHash, now);
                    }
                    return this.#publishedProject(projectId);
                });
            } catch (error) {
                const asset = this.#database
                    .prepare("SELECT 1 FROM project_avatar_assets WHERE hash = ?")
                    .get(normalized.hash);
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
        const previousHash = project.avatar?.hash;
        const now = this.#now();
        const updated = this.#transaction(() => {
            this.#database
                .prepare(
                    `
                    UPDATE projects
                    SET avatar_hash = NULL, avatar_source = NULL,
                        initialization_status = CASE
                            WHEN kind = 'regular' THEN 'initializing'
                            ELSE initialization_status
                        END,
                        initialization_error = CASE
                            WHEN kind = 'regular' THEN NULL
                            ELSE initialization_error
                        END,
                        version = version + 1,
                        updated_at_ms = ?
                    WHERE id = ?
                    `,
                )
                .run(now, projectId);
            if (previousHash !== undefined) this.#dereferenceAvatar(previousHash, now);
            return this.#publishedProject(projectId);
        });
        if (updated?.kind === "regular") this.scheduleInitialization(projectId);
        return updated;
    }

    async avatarAsset(hash: string): Promise<ProjectAvatarAsset | undefined> {
        if (!/^[a-f0-9]{64}$/u.test(hash)) return undefined;
        const row = this.#database
            .prepare("SELECT media_type FROM project_avatar_assets WHERE hash = ?")
            .get(hash);
        if (row === undefined) return undefined;
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
    ): Promise<ProjectWorkspace | undefined> {
        const project = this.getProject(projectId);
        if (project === undefined) return undefined;
        const name = validateProjectName(request.name);
        const clientRequestId = request.clientRequestId.trim();
        if (clientRequestId.length === 0 || clientRequestId.length > 200) {
            throw new Error("A workspace request ID is required.");
        }
        const baseRef = request.baseRef.trim();
        if (
            baseRef.length === 0 ||
            baseRef.length > 200 ||
            baseRef.startsWith("-") ||
            /[\p{Cc}\p{Cf}]/u.test(baseRef)
        ) {
            throw new Error("The workspace base reference is invalid.");
        }
        const retry = this.#database
            .prepare(
                "SELECT * FROM project_workspaces WHERE project_id = ? AND client_request_id = ?",
            )
            .get(projectId, clientRequestId);
        if (retry !== undefined) {
            const workspace = readWorkspace(retry);
            if (
                projectNameKey(workspace.name) !== projectNameKey(name) ||
                workspace.baseRef !== baseRef
            ) {
                throw new Error("The workspace request ID was already used with other settings.");
            }
            return workspace;
        }

        const gitTopLevel = normalizeProjectCwd(
            await this.#git(project.path, ["rev-parse", "--show-toplevel"]),
        );
        if (gitTopLevel !== project.path) {
            throw new Error("Managed workspaces require a Git repository project.");
        }
        const gitCommonDir = normalizeProjectCwd(
            resolve(
                project.path,
                await this.#git(project.path, [
                    "rev-parse",
                    "--path-format=absolute",
                    "--git-common-dir",
                ]),
            ),
        );
        const commit = await this.#git(project.path, [
            "rev-parse",
            "--verify",
            "--end-of-options",
            `${baseRef}^{commit}`,
        ]);
        if (!/^[a-f0-9]{40,64}$/iu.test(commit)) {
            throw new Error("The workspace base reference did not resolve to a commit.");
        }

        const reservation = this.#transaction(() => {
            const postflightRetry = this.#database
                .prepare(
                    "SELECT * FROM project_workspaces WHERE project_id = ? AND client_request_id = ?",
                )
                .get(projectId, clientRequestId);
            if (postflightRetry !== undefined) {
                const workspace = readWorkspace(postflightRetry);
                if (
                    projectNameKey(workspace.name) !== projectNameKey(name) ||
                    workspace.baseRef !== baseRef
                ) {
                    throw new Error(
                        "The workspace request ID was already used with other settings.",
                    );
                }
                return { created: false, workspace };
            }

            const visibleName = this.#reserveWorkspaceName(projectId, name);
            const storageKey = this.#reserveWorkspaceStorageKey(projectId, projectStorageKey(name));
            const path = join(this.#stateDirectory, "workspaces", project.storageKey, storageKey);
            const now = this.#now();
            const workspaceId = createId();
            this.#database
                .prepare(
                    `
                    INSERT INTO project_workspaces (
                        id, project_id, path, storage_key, name, name_key, order_key, kind, status,
                        base_ref, base_commit, git_common_dir, client_request_id, version,
                        created_at_ms, updated_at_ms
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'git_worktree', 'initializing', ?, ?, ?, ?, 1, ?, ?)
                    `,
                )
                .run(
                    workspaceId,
                    projectId,
                    path,
                    storageKey,
                    visibleName,
                    projectNameKey(visibleName),
                    this.#newFirstWorkspaceOrderKey(projectId),
                    baseRef,
                    // The ref text can move or disappear later, so the immutable OID it resolved to
                    // is what anchors this workspace's comparison base.
                    commit.toLocaleLowerCase(),
                    gitCommonDir,
                    clientRequestId,
                    now,
                    now,
                );
            const workspace = this.getWorkspace(projectId, workspaceId);
            if (workspace === undefined) throw new Error("The workspace could not be reserved.");
            this.#publishWorkspace("workspace_created", workspace);
            return { created: true, workspace };
        });
        if (reservation.created) {
            setImmediate(() => {
                this.#runBackgroundTask(() =>
                    this.#materializeWorkspace(
                        reservation.workspace,
                        project.path,
                        commit.toLocaleLowerCase(),
                    ),
                );
            });
        }
        return reservation.workspace;
    }

    renameWorkspace(
        projectId: string,
        workspaceId: string,
        requestedName: string,
        expectedVersion?: number,
    ): ProjectWorkspace | undefined {
        const current = this.getWorkspace(projectId, workspaceId);
        if (current === undefined) return undefined;
        if (expectedVersion !== undefined && expectedVersion !== current.version) {
            throw new Error("The workspace changed before it could be renamed.");
        }
        const name = this.#reserveWorkspaceName(
            projectId,
            validateProjectName(requestedName),
            workspaceId,
        );
        return this.#transaction(() => {
            this.#database
                .prepare(
                    `
                    UPDATE project_workspaces
                    SET name = ?, name_key = ?, version = version + 1, updated_at_ms = ?
                    WHERE id = ? AND project_id = ?
                    `,
                )
                .run(name, projectNameKey(name), this.#now(), workspaceId, projectId);
            return this.#publishedWorkspace(projectId, workspaceId);
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
        return this.#transaction(() => {
            this.#database
                .prepare(
                    `
                    UPDATE project_workspaces
                    SET order_key = ?, version = version + 1, updated_at_ms = ?
                    WHERE id = ? AND project_id = ?
                    `,
                )
                .run(orderKey, this.#now(), workspaceId, projectId);
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
        return this.#transaction(() => {
            this.#database
                .prepare(
                    `
                    UPDATE projects
                    SET archived_at_ms = ?, version = version + 1, updated_at_ms = ?
                    WHERE id = ? AND archived_at_ms IS NULL
                    `,
                )
                .run(now, now, projectId);
            return this.#publishedProject(projectId);
        });
    }

    unarchiveProject(projectId: string): Project | undefined {
        const project = this.getProject(projectId);
        if (project === undefined || project.archivedAt === undefined) return project;
        return this.#transaction(() => {
            this.#database
                .prepare(
                    `
                    UPDATE projects
                    SET archived_at_ms = NULL, version = version + 1, updated_at_ms = ?
                    WHERE id = ? AND archived_at_ms IS NOT NULL
                    `,
                )
                .run(this.#now(), projectId);
            return this.#publishedProject(projectId);
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
            return workspace;
        }
        if (expectedVersion !== undefined && expectedVersion !== workspace.version) {
            throw new Error("The workspace changed before it could be archived.");
        }
        return this.#transaction(() => {
            this.#database
                .prepare(
                    `
                    UPDATE project_workspaces
                    SET status = 'archiving', error = NULL,
                        version = version + 1, updated_at_ms = ?
                    WHERE id = ? AND project_id = ? AND status != 'archived'
                    `,
                )
                .run(this.#now(), workspaceId, projectId);
            return this.#publishedWorkspace(projectId, workspaceId);
        });
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
                if (!this.#closed) {
                    this.#finishWorkspaceArchive(
                        projectId,
                        workspaceId,
                        "archive_failed",
                        errorToMessage(error),
                    );
                }
            }
        });
        return this.getWorkspace(projectId, workspaceId);
    }

    failWorkspaceArchive(
        projectId: string,
        workspaceId: string,
        error: string,
    ): ProjectWorkspace | undefined {
        this.#finishWorkspaceArchive(projectId, workspaceId, "archive_failed", error);
        return this.getWorkspace(projectId, workspaceId);
    }

    #reserveProjectName(base: string, excludeId?: string): string {
        return reserveUnique(base, (key) => {
            const row =
                excludeId === undefined
                    ? this.#database.prepare("SELECT 1 FROM projects WHERE name_key = ?").get(key)
                    : this.#database
                          .prepare("SELECT 1 FROM projects WHERE name_key = ? AND id != ?")
                          .get(key, excludeId);
            return row !== undefined;
        });
    }

    #newFirstProjectOrderKey(): string {
        const row = this.#database
            .prepare("SELECT order_key FROM projects ORDER BY order_key ASC LIMIT 1")
            .get();
        return generateKeyBetween(null, row === undefined ? null : readString(row, "order_key"));
    }

    #newFirstWorkspaceOrderKey(projectId: string): string {
        const row = this.#database
            .prepare(
                "SELECT order_key FROM project_workspaces WHERE project_id = ? ORDER BY order_key ASC LIMIT 1",
            )
            .get(projectId);
        return generateKeyBetween(null, row === undefined ? null : readString(row, "order_key"));
    }

    #reserveProjectStorageKey(base: string): string {
        return reserveUniqueKey(base, (candidate) => {
            return (
                this.#database
                    .prepare("SELECT 1 FROM projects WHERE storage_key = ? COLLATE NOCASE")
                    .get(candidate) !== undefined
            );
        });
    }

    #reserveWorkspaceName(projectId: string, base: string, excludeId?: string): string {
        return reserveUnique(base, (key) => {
            const row =
                excludeId === undefined
                    ? this.#database
                          .prepare(
                              "SELECT 1 FROM project_workspaces WHERE project_id = ? AND name_key = ?",
                          )
                          .get(projectId, key)
                    : this.#database
                          .prepare(
                              "SELECT 1 FROM project_workspaces WHERE project_id = ? AND name_key = ? AND id != ?",
                          )
                          .get(projectId, key, excludeId);
            return row !== undefined;
        });
    }

    #reserveWorkspaceStorageKey(projectId: string, base: string): string {
        return reserveUniqueKey(base, (candidate) => {
            return (
                this.#database
                    .prepare(
                        "SELECT 1 FROM project_workspaces WHERE project_id = ? AND storage_key = ? COLLATE NOCASE",
                    )
                    .get(projectId, candidate) !== undefined
            );
        });
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
                const topLevel = normalizeProjectCwd(
                    await this.#git(project.path, ["rev-parse", "--show-toplevel"]),
                );
                repositoryTopLevel = topLevel === project.path;
                if (repositoryTopLevel) remote = await this.#selectRemote(project.path);
            } catch {
                // A regular non-Git directory is a valid project.
            }
            if (this.#closed) return;

            const detectedName = remote === undefined ? undefined : remoteProjectName(remote);
            const current = this.getProject(projectId);
            if (current === undefined) return;
            if (detectedName !== undefined && current.nameSource === "folder") {
                this.#transaction(() => {
                    const name = this.#reserveProjectName(detectedName, projectId);
                    const result = this.#database
                        .prepare(
                            `
                            UPDATE projects
                            SET name = ?, name_key = ?, name_source = 'git_remote',
                                version = version + 1, updated_at_ms = ?
                            WHERE id = ? AND name_source = 'folder'
                            `,
                        )
                        .run(name, projectNameKey(name), this.#now(), projectId);
                    if (result.changes > 0) this.#publishedProject(projectId);
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

            this.#transaction(() => {
                const result = this.#database
                    .prepare(
                        `
                        UPDATE projects
                        SET initialization_status = 'ready', initialization_error = NULL,
                            initialization_attempt = initialization_attempt + 1,
                            version = version + 1, updated_at_ms = ?
                        WHERE id = ? AND initialization_status = 'initializing'
                        `,
                    )
                    .run(this.#now(), projectId);
                if (result.changes > 0) this.#publishedProject(projectId);
            });
        } catch (error) {
            if (this.#closed) return;
            this.#transaction(() => {
                const result = this.#database
                    .prepare(
                        `
                        UPDATE projects
                        SET initialization_status = 'failed', initialization_error = ?,
                            initialization_attempt = initialization_attempt + 1,
                            version = version + 1, updated_at_ms = ?
                        WHERE id = ? AND initialization_status = 'initializing'
                        `,
                    )
                    .run(
                        errorToMessage(error).slice(0, PROJECT_ERROR_LENGTH),
                        this.#now(),
                        projectId,
                    );
                if (result.changes > 0) this.#publishedProject(projectId);
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
                .catch(() => undefined);
        }
    }

    async #selectRemote(cwd: string): Promise<string | undefined> {
        try {
            const branch = await this.#git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
            const trackedRemote = await this.#git(cwd, [
                "config",
                "--get",
                `branch.${branch}.remote`,
            ]);
            if (trackedRemote !== ".") {
                return await this.#git(cwd, ["config", "--get", `remote.${trackedRemote}.url`]);
            }
        } catch {
            // Fall through to origin and then stable remote order.
        }
        try {
            return await this.#git(cwd, ["config", "--get", "remote.origin.url"]);
        } catch {
            // Fall through.
        }
        try {
            const remotes = (await this.#git(cwd, ["remote"]))
                .split(/\r?\n/gu)
                .map((value) => value.trim())
                .filter(Boolean);
            for (const remote of remotes) {
                const url = await this.#git(cwd, ["config", "--get", `remote.${remote}.url`]);
                if (remoteProjectName(url) !== undefined) return url;
            }
        } catch {
            // No usable remote.
        }
        return undefined;
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
        const rows = this.#database
            .prepare(
                `
                SELECT hash
                FROM project_avatar_assets
                WHERE dereferenced_at_ms IS NOT NULL
                    AND dereferenced_at_ms <= ?
                    AND NOT EXISTS (
                        SELECT 1 FROM projects WHERE projects.avatar_hash = project_avatar_assets.hash
                    )
                ORDER BY dereferenced_at_ms ASC, hash ASC
                LIMIT 100
                `,
            )
            .all(cutoff);
        for (const row of rows) {
            if (this.#closed) return;
            const hash = readString(row, "hash");
            await this.#withAvatarLifecycleLock(hash, async () => {
                if (this.#closed) return;
                const removed = this.#transaction(() =>
                    this.#database
                        .prepare(
                            `
                            DELETE FROM project_avatar_assets
                            WHERE hash = ?
                                AND dereferenced_at_ms IS NOT NULL
                                AND dereferenced_at_ms <= ?
                                AND NOT EXISTS (
                                    SELECT 1 FROM projects WHERE projects.avatar_hash = project_avatar_assets.hash
                                )
                            `,
                        )
                        .run(hash, cutoff),
                );
                if (removed.changes > 0) {
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
                try {
                    const topLevel = normalizeProjectCwd(
                        await this.#git(workspace.path, ["rev-parse", "--show-toplevel"]),
                    );
                    const commonDirectory = normalizeProjectCwd(
                        resolve(
                            workspace.path,
                            await this.#git(workspace.path, [
                                "rev-parse",
                                "--path-format=absolute",
                                "--git-common-dir",
                            ]),
                        ),
                    );
                    if (
                        topLevel === normalizeProjectCwd(workspace.path) &&
                        commonDirectory === workspace.gitCommonDir
                    ) {
                        this.#markWorkspaceReady(workspace);
                        return;
                    }
                } catch {
                    // A partial managed worktree is cleaned up before retrying creation.
                }
                await this.#removeWorkspaceDirectory(project, workspace);
            }
            if (this.#closed) return;
            if (workspace.baseRef === undefined) {
                throw new Error("The workspace base reference is unavailable.");
            }
            const commit = await this.#git(project.path, [
                "rev-parse",
                "--verify",
                "--end-of-options",
                `${workspace.baseRef}^{commit}`,
            ]);
            if (!/^[a-f0-9]{40,64}$/iu.test(commit)) {
                throw new Error("The workspace base reference no longer resolves to a commit.");
            }
            await this.#materializeWorkspaceLocked(
                workspace,
                project.path,
                commit.toLocaleLowerCase(),
            );
        } catch (error) {
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
        const expectedPath = resolve(
            this.#stateDirectory,
            "workspaces",
            project.storageKey,
            workspace.storageKey,
        );
        if (resolve(workspace.path) !== expectedPath) {
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
            const sourceCommonDirectory = normalizeProjectCwd(
                resolve(
                    project.path,
                    await this.#git(project.path, [
                        "rev-parse",
                        "--path-format=absolute",
                        "--git-common-dir",
                    ]),
                ),
            );
            if (sourceCommonDirectory !== workspace.gitCommonDir) {
                throw new Error("The source repository no longer owns this workspace.");
            }
            if (workspaceExists) {
                await this.#git(project.path, [
                    "worktree",
                    "remove",
                    "--force",
                    "--force",
                    workspace.path,
                ]);
            }
            await this.#git(project.path, ["worktree", "prune"]);
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
            await mkdir(dirname(workspace.path), { recursive: true, mode: 0o700 });
            await this.#git(projectPath, [
                "worktree",
                "add",
                "--detach",
                "--",
                workspace.path,
                commit,
            ]);
            const topLevel = normalizeProjectCwd(
                await this.#git(workspace.path, ["rev-parse", "--show-toplevel"]),
            );
            const commonDirectory = normalizeProjectCwd(
                resolve(
                    workspace.path,
                    await this.#git(workspace.path, [
                        "rev-parse",
                        "--path-format=absolute",
                        "--git-common-dir",
                    ]),
                ),
            );
            if (topLevel !== normalizeProjectCwd(workspace.path)) {
                throw new Error("Git created the worktree at an unexpected path.");
            }
            if (commonDirectory !== workspace.gitCommonDir) {
                throw new Error("Git created the worktree from an unexpected repository.");
            }
            if (this.#closed) return;
            this.#transaction(() => {
                const result = this.#database
                    .prepare(
                        `
                        UPDATE project_workspaces
                        SET status = 'ready', error = NULL, version = version + 1, updated_at_ms = ?
                        WHERE id = ? AND status = 'initializing'
                        `,
                    )
                    .run(this.#now(), workspace.id);
                if (result.changes > 0) {
                    this.#publishedWorkspace(workspace.projectId, workspace.id);
                }
            });
        } catch (error) {
            if (this.#closed) return;
            this.#transaction(() => {
                const result = this.#database
                    .prepare(
                        `
                        UPDATE project_workspaces
                        SET status = 'failed', error = ?, version = version + 1, updated_at_ms = ?
                        WHERE id = ? AND status = 'initializing'
                        `,
                    )
                    .run(
                        errorToMessage(error).slice(0, PROJECT_ERROR_LENGTH),
                        this.#now(),
                        workspace.id,
                    );
                if (result.changes > 0) {
                    this.#publishedWorkspace(workspace.projectId, workspace.id);
                }
            });
        }
    }

    #markWorkspaceReady(workspace: ProjectWorkspace): void {
        this.#transaction(() => {
            const result = this.#database
                .prepare(
                    `
                    UPDATE project_workspaces
                    SET status = 'ready', error = NULL,
                        version = version + 1, updated_at_ms = ?
                    WHERE id = ? AND status = 'initializing'
                    `,
                )
                .run(this.#now(), workspace.id);
            if (result.changes > 0) {
                this.#publishedWorkspace(workspace.projectId, workspace.id);
            }
        });
    }

    #markWorkspaceInitializationFailed(workspace: ProjectWorkspace, error: string): void {
        this.#transaction(() => {
            const result = this.#database
                .prepare(
                    `
                    UPDATE project_workspaces
                    SET status = 'failed', error = ?,
                        version = version + 1, updated_at_ms = ?
                    WHERE id = ? AND status = 'initializing'
                    `,
                )
                .run(error.slice(0, PROJECT_ERROR_LENGTH), this.#now(), workspace.id);
            if (result.changes > 0) {
                this.#publishedWorkspace(workspace.projectId, workspace.id);
            }
        });
    }

    #finishWorkspaceArchive(
        projectId: string,
        workspaceId: string,
        status: "archived" | "archive_failed",
        error?: string,
    ): void {
        const now = this.#now();
        this.#transaction(() => {
            const result = this.#database
                .prepare(
                    `
                    UPDATE project_workspaces
                    SET status = ?, error = ?, archived_at_ms = ?,
                        version = version + 1, updated_at_ms = ?
                    WHERE id = ? AND project_id = ? AND status = 'archiving'
                    `,
                )
                .run(
                    status,
                    error?.slice(0, PROJECT_ERROR_LENGTH) ?? null,
                    status === "archived" ? now : null,
                    now,
                    workspaceId,
                    projectId,
                );
            if (result.changes > 0) {
                this.#publishedWorkspace(projectId, workspaceId);
            }
        });
    }

    async #git(cwd: string, args: readonly string[]): Promise<string> {
        return this.#gitRunner(cwd, args);
    }

    #transaction<T>(body: () => T): T {
        if (this.#database.isTransaction) return body();
        if (this.#transactionRunner !== undefined) {
            return this.#transactionRunner(body);
        }
        this.#database.exec("BEGIN IMMEDIATE");
        try {
            const result = body();
            this.#database.exec("COMMIT");
            return result;
        } catch (error) {
            this.#database.exec("ROLLBACK");
            throw error;
        }
    }

    #runBackgroundTask(task: () => Promise<void>): void {
        if (this.#closed) return;
        const promise = this.#taskDrain?.run(task) ?? task();
        void promise.catch(() => undefined);
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

    #publishedProject(projectId: string): Project | undefined {
        const project = this.getProject(projectId);
        if (project !== undefined) this.#publishProject("project_updated", project);
        return project;
    }

    #publishedWorkspace(projectId: string, workspaceId: string): ProjectWorkspace | undefined {
        const workspace = this.getWorkspace(projectId, workspaceId);
        if (workspace !== undefined) this.#publishWorkspace("workspace_updated", workspace);
        return workspace;
    }

    #publishProject(type: ProjectEvent["type"], project: Project): void {
        const event = {
            createdAt: this.#now(),
            data: { project },
            id: this.#createEventId(),
            projectId: project.id,
            type,
        } as ProjectEvent;
        this.#onEvent?.(event);
    }

    #publishWorkspace(type: ProjectWorkspaceEvent["type"], workspace: ProjectWorkspace): void {
        const event = {
            createdAt: this.#now(),
            data: { workspace },
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

    #dereferenceAvatar(hash: string, now: number): void {
        const references = this.#database
            .prepare("SELECT COUNT(*) AS count FROM projects WHERE avatar_hash = ?")
            .get(hash);
        if (readNumber(references ?? {}, "count") === 0) {
            this.#database
                .prepare("UPDATE project_avatar_assets SET dereferenced_at_ms = ? WHERE hash = ?")
                .run(now, hash);
        }
    }

    #readProject(row: Record<string, unknown>): Project {
        const project = readProject(row);
        const avatarHash = readOptionalString(row, "avatar_hash");
        const avatarSource = readOptionalString(row, "avatar_source");
        if (avatarHash === undefined || avatarSource === undefined) return project;
        const asset = this.#database
            .prepare("SELECT width, height FROM project_avatar_assets WHERE hash = ?")
            .get(avatarHash);
        if (asset === undefined) return project;
        project.avatar = {
            hash: avatarHash,
            height: readNumber(asset, "height"),
            mediaType: "image/webp",
            source: avatarSource as ProjectAvatar["source"],
            url: `/project-assets/${avatarHash}`,
            width: readNumber(asset, "width"),
        };
        return project;
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

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
    const result = await execFile("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: 5_000,
    });
    return result.stdout.trim();
}

/**
 * Column bindings for a project probe, in the order used by both the SET clause and the
 * change-detection WHERE clause so an unchanged probe updates no row and publishes no event.
 */
function gitFactBindings(probe: GitRepositoryProbe): (string | number | null)[] {
    return [
        probe.presence,
        probe.worktreeSupport,
        probe.worktreeSupportReason ?? null,
        ...workspaceGitFactBindings(probe).slice(1),
    ];
}

function workspaceGitFactBindings(probe: GitRepositoryProbe): (string | number | null)[] {
    return [
        probe.presence,
        probe.facts?.branch ?? null,
        probe.facts?.head ?? null,
        probe.facts?.upstream ?? null,
        probe.facts?.ahead ?? 0,
        probe.facts?.behind ?? 0,
        probe.facts?.detached === true ? 1 : 0,
    ];
}

function readProject(row: Record<string, unknown>): Project {
    const archivedAt = readOptionalNumber(row, "archived_at_ms");
    const avatarHash = readOptionalString(row, "avatar_hash");
    const initializationError = readOptionalString(row, "initialization_error");
    const worktreeSupportReason = readOptionalString(row, "worktree_support_reason");
    const git = readGitFacts(row);
    const project: Project = {
        ...(archivedAt === undefined ? {} : { archivedAt }),
        createdAt: readNumber(row, "created_at_ms"),
        ...(git === undefined ? {} : { git }),
        id: readString(row, "id"),
        initializationAttempt: readNumber(row, "initialization_attempt"),
        initializationStatus: readString(
            row,
            "initialization_status",
        ) as Project["initializationStatus"],
        kind: readString(row, "kind") as Project["kind"],
        name: readString(row, "name"),
        nameSource: readString(row, "name_source") as Project["nameSource"],
        orderKey: readString(row, "order_key"),
        path: readString(row, "path"),
        presence: readString(row, "presence") as Project["presence"],
        storageKey: readString(row, "storage_key"),
        updatedAt: readNumber(row, "updated_at_ms"),
        version: readNumber(row, "version"),
        worktreeSupport: readString(row, "worktree_support") as Project["worktreeSupport"],
        ...(worktreeSupportReason === undefined ? {} : { worktreeSupportReason }),
    };
    if (project.kind === "home" && avatarHash === undefined) project.avatarBuiltin = "home";
    if (initializationError !== undefined) project.initializationError = initializationError;
    return project;
}

/**
 * Git facts are absent until a probe has observed the repository. A row that has never resolved a
 * HEAD and is not on a branch reports no facts at all rather than a misleading detached zero state.
 */
function readGitFacts(row: Record<string, unknown>): GitRepositoryFacts | undefined {
    const branch = readOptionalString(row, "git_branch");
    const head = readOptionalString(row, "git_head");
    const upstream = readOptionalString(row, "git_upstream");
    const detached = readNumber(row, "git_detached") !== 0;
    if (branch === undefined && head === undefined && !detached) return undefined;
    return {
        ahead: readNumber(row, "git_ahead"),
        behind: readNumber(row, "git_behind"),
        ...(branch === undefined ? {} : { branch }),
        detached,
        ...(head === undefined ? {} : { head }),
        ...(upstream === undefined ? {} : { upstream }),
    };
}

function readWorkspace(row: Record<string, unknown>): ProjectWorkspace {
    const archivedAt = readOptionalNumber(row, "archived_at_ms");
    const baseCommit = readOptionalString(row, "base_commit");
    const baseRef = readOptionalString(row, "base_ref");
    const error = readOptionalString(row, "error");
    const git = readGitFacts(row);
    return {
        ...(archivedAt === undefined ? {} : { archivedAt }),
        ...(baseCommit === undefined ? {} : { baseCommit }),
        ...(baseRef === undefined ? {} : { baseRef }),
        createdAt: readNumber(row, "created_at_ms"),
        ...(error === undefined ? {} : { error }),
        ...(git === undefined ? {} : { git }),
        gitCommonDir: readString(row, "git_common_dir"),
        id: readString(row, "id"),
        kind: readString(row, "kind") as ProjectWorkspace["kind"],
        name: readString(row, "name"),
        orderKey: readString(row, "order_key"),
        path: readString(row, "path"),
        presence: readString(row, "presence") as ProjectWorkspace["presence"],
        projectId: readString(row, "project_id"),
        status: readString(row, "status") as ProjectWorkspace["status"],
        storageKey: readString(row, "storage_key"),
        updatedAt: readNumber(row, "updated_at_ms"),
        version: readNumber(row, "version"),
    };
}

function reserveUnique(base: string, exists: (key: string) => boolean): string {
    let suffix = 1;
    for (;;) {
        const candidate = suffix === 1 ? base : `${base} (${String(suffix)})`;
        if (!exists(projectNameKey(candidate))) return candidate;
        suffix += 1;
    }
}

function reserveUniqueKey(base: string, exists: (key: string) => boolean): string {
    let suffix = 1;
    for (;;) {
        const candidate = suffix === 1 ? base : `${base}-${String(suffix)}`;
        if (!exists(candidate)) return candidate;
        suffix += 1;
    }
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

function readString(row: Record<string, unknown>, key: string): string {
    const value = row[key];
    if (typeof value !== "string") throw new Error(`Expected text SQLite column '${key}'.`);
    return value;
}

function readOptionalString(row: Record<string, unknown>, key: string): string | undefined {
    const value = row[key];
    if (value === null || value === undefined) return undefined;
    if (typeof value !== "string") throw new Error(`Expected text SQLite column '${key}'.`);
    return value;
}

function readNumber(row: Record<string, unknown>, key: string): number {
    const value = row[key];
    if (typeof value === "number") return value;
    if (typeof value === "bigint") return Number(value);
    throw new Error(`Expected numeric SQLite column '${key}'.`);
}

function readOptionalNumber(row: Record<string, unknown>, key: string): number | undefined {
    const value = row[key];
    if (value === null || value === undefined) return undefined;
    if (typeof value === "number") return value;
    if (typeof value === "bigint") return Number(value);
    throw new Error(`Expected numeric SQLite column '${key}'.`);
}
