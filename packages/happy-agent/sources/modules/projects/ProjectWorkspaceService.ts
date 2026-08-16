import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { createId } from "@paralleldrive/cuid2";
import {
    folderProjectName,
    HOME_PROJECT_NAME,
    projectStorageKey,
    type Project,
    type ProjectAvatarAssetReader,
    type ProjectAvatarSource,
    type ProjectGitFacts,
    type ProjectRemoteSource,
    type ProjectSettings,
    type ProjectSettingsUpdateInput,
    type ProjectsModule,
    type Workspace,
    type WorkspacesModule,
} from "@slopus/happy-agent-modules";
import {
    mapAsyncLock,
    type Context,
    type MapAsyncLock,
    type RootContext,
} from "@steve.kite/stdlib";

import { cloneRemoteRepository, remoteUrlForSource } from "../git/cloneRemoteRepository.js";
import { createGitWorktree } from "../git/createGitWorktree.js";
import { detectGitDefaultBranch } from "../git/detectGitDefaultBranch.js";
import { GitCredentialBroker, type GitAuthentication } from "../git/GitCredentialBroker.js";
import type { GitCommandRunner } from "../git/GitCommandRunner.js";
import { isGitWorktreeAt } from "../git/isGitWorktreeAt.js";
import { normalizeProjectCwd } from "../git/normalizeProjectCwd.js";
import {
    prepareWorkspaceTransfer,
    WorkspaceTransferTargetRestoreError,
    type PreparedWorkspaceTransfer,
} from "../git/prepareWorkspaceTransfer.js";
import { probeGitRepository, type GitRepositoryProbe } from "../git/probeGitRepository.js";
import { readGitCommonDir } from "../git/readGitCommonDir.js";
import { readGitTopLevel } from "../git/readGitTopLevel.js";
import { remoteProjectName } from "../git/remoteProjectName.js";
import { renameGitBranch } from "../git/renameGitBranch.js";
import { resolveWorkspaceBase } from "../git/resolveWorkspaceBase.js";
import { directGitCommandRunner, runGitCommandWithEnvironment } from "../git/runGitCommand.js";
import { runSandboxedGitCommand } from "../git/runSandboxedGitCommand.js";
import { selectGitRemoteUrl } from "../git/selectGitRemoteUrl.js";
import type {
    GitChangeSnapshot,
    GitRepositoryFacts,
    GitTrackedEntity,
    ProjectCreator,
} from "../git/types.js";
import { collectProjectAvatarGarbage } from "./collectProjectAvatarGarbage.js";
import { copyProjectFolder } from "./copyProjectFolder.js";
import { findHostingAvatar, findRepositoryAvatar } from "./findProjectAvatar.js";
import {
    generateWorkspaceNames,
    withPreservedNumericPrefix,
    type WorkspaceNameGenerator,
} from "./generateWorkspaceNames.js";
import { getManagedProjectsDirectory } from "./getManagedProjectsDirectory.js";
import { getManagedWorkspacesDirectory } from "./getManagedWorkspacesDirectory.js";
import {
    DEFAULT_WORKSPACE_FOLDER_SETTINGS,
    loadWorkspaceFolderSettings,
    type WorkspaceFolderSettings,
} from "./loadWorkspaceFolderSettings.js";
import { MAX_AVATAR_BYTES, normalizeProjectAvatar } from "./normalizeProjectAvatar.js";
import { normalizeFuturePath } from "./normalizeFuturePath.js";
import type { ProjectCreatorProfile } from "./ProjectHost.js";
import { ProjectAvatarStore } from "./ProjectAvatarStore.js";
import { ProjectRegistrationError } from "./ProjectRegistrationError.js";
import {
    clientChosenId,
    clientChosenProjectId,
    requestedBaseRef,
    validateManagedProjectFolderName,
    validateProjectName,
} from "./projectNames.js";
import { removeWorkspaceDirectory } from "./removeWorkspaceDirectory.js";
import { runWorkspaceSetupCommands } from "./runWorkspaceSetupCommands.js";
import { syncWorkspaceFiles } from "./syncWorkspaceFiles.js";
import { validateRegistrationPath } from "./validateRegistrationPath.js";
import { watchWorkspaceSyncPaths } from "./watchWorkspaceSyncPaths.js";
import {
    gitBranchExists,
    workspaceGitRefSnapshot,
    workspaceStorageKeyExists,
} from "./workspaceGitRefSnapshot.js";

const MAX_ERROR_LENGTH = 500;
const WORKSPACE_SYNC_DEBOUNCE_MS = 300;
const GIT_PROBE_CONCURRENCY = 4;
const WORKSPACE_INITIALIZATION_CONCURRENCY = 4;
const MAX_PROJECT_INITIALIZATION_RETRIES = 3;

export interface ResolvedProjectOwnership {
    readonly project: Project;
    readonly workspace?: Workspace;
}

export interface CreateWorkspaceRequest {
    readonly baseRef?: string;
    readonly id?: string;
    readonly name: string;
    readonly nameConfigured?: boolean;
    readonly secret?: { readonly kind: "github" };
}

export interface CreateRemoteProjectRequest {
    readonly name: string;
    readonly projectId?: string;
    readonly secret?: { readonly kind: "github" };
    readonly source: ProjectRemoteSource;
}

export interface ProjectSessionSettings {
    readonly projectId: string;
    readonly settings: ProjectSettings;
    readonly workspaceId?: string;
}

/** What a host answers for one project so the workspaces catalog can pick a free folder key. */
export interface WorkspaceCatalogHost {
    pathForStorageKey(projectRef: string, storageKey: string): string;
    isBranchUnavailable(projectRef: string, branch: string): boolean;
    isStorageKeyUnavailable(projectRef: string, storageKey: string): boolean;
}

export interface ProjectWorkspaceServiceOptions {
    readonly agentId: string;
    readonly cloneRemote?: typeof cloneRemoteRepository;
    readonly environment?: NodeJS.ProcessEnv;
    /**
     * Applied to each background lifetime after it is named.
     *
     * A background context is derived from the application root, which carries the logger and the
     * tracer but nothing an agent added later. Work that reaches the catalogs needs the agent
     * database on its context, so the caller that owns the database attaches it here — once per
     * lifetime rather than once per call.
     */
    readonly extendBackgroundContext?: (ctx: Context) => Context;
    readonly git?: GitCommandRunner;
    readonly gitCredentialBroker?: GitCredentialBroker;
    readonly homeDirectory?: string;
    readonly localCreator?: ProjectCreator;
    readonly localInstanceId?: string;
    readonly managedProjectsDirectory?: string;
    readonly nameGenerator?: WorkspaceNameGenerator;
    readonly now?: () => number;
    readonly onWorkspaceBranchError?: (
        error: unknown,
        projectId: string,
        workspaceId: string,
    ) => void;
    readonly onWorkspaceCleanupError?: (
        error: unknown,
        projectId: string,
        workspaceId: string,
    ) => void;
    readonly probeGit?: GitCommandRunner;
    readonly projects: ProjectsModule;
    readonly resolveGitSecret?: (kind: "github") => string | undefined;
    readonly resolveProfile?: (
        profileId: string,
    ) => ProjectCreatorProfile | undefined | Promise<ProjectCreatorProfile | undefined>;
    readonly rootContext: RootContext;
    readonly settings?: WorkspaceFolderSettings;
    readonly stateDirectory?: string;
    readonly workspaces: WorkspacesModule;
    readonly workspacesDirectory?: string;
}

/**
 * The host half of projects and workspaces.
 *
 * The catalogs own what is durable — which folder is a project, which branch a workspace is on,
 * how far its setup got. This owns everything those records describe but cannot do: canonical
 * paths, managed directories, Git worktrees, clones, setup commands, file replication, folder
 * removal, and the background work that carries a reservation through to a usable checkout.
 *
 * Every background lifetime it starts — initialization, sync, watching, cleanup, maintenance —
 * runs on its own named context derived from the application root, never on the request or turn
 * that happened to trigger it, and `close` stops all of them.
 */
export class ProjectWorkspaceService {
    readonly #agentId: string;
    readonly #avatars: ProjectAvatarStore;
    readonly #avatarLocks: MapAsyncLock<string> = mapAsyncLock();
    readonly #backgroundAbort = new AbortController();
    readonly #cloneRemote: typeof cloneRemoteRepository;
    readonly #creators = new Map<string, ProjectCreator>();
    readonly #environment: NodeJS.ProcessEnv;
    readonly #git: GitCommandRunner;
    readonly #gitCredentialBroker: GitCredentialBroker;
    readonly #hasCustomGit: boolean;
    readonly #homeDirectory: string;
    readonly #initializing = new Set<string>();
    readonly #localCreator: ProjectCreator | undefined;
    readonly #localInstanceId: string | undefined;
    readonly #managedProjectsDirectory: string;
    readonly #nameGenerator: WorkspaceNameGenerator | undefined;
    readonly #now: () => number;
    readonly #onWorkspaceBranchError:
        | ((error: unknown, projectId: string, workspaceId: string) => void)
        | undefined;
    readonly #onWorkspaceCleanupError:
        | ((error: unknown, projectId: string, workspaceId: string) => void)
        | undefined;
    readonly #pendingInitializations: string[] = [];
    readonly #probeGit: GitCommandRunner;
    readonly #projectFolders = new Map<string, { path: string; storageKey: string }>();
    readonly #projectLocks: MapAsyncLock<string> = mapAsyncLock();
    readonly #projects: ProjectsModule;
    readonly #resolveGitSecret: ((kind: "github") => string | undefined) | undefined;
    readonly #resolveProfile: ProjectWorkspaceServiceOptions["resolveProfile"];
    readonly #settings: WorkspaceFolderSettings;
    readonly #stateDirectory: string;
    readonly #tasks = new Set<Promise<void>>();
    readonly #workspaceLocks: MapAsyncLock<string> = mapAsyncLock();
    readonly #workspaceSetupControllers = new Map<string, AbortController>();
    readonly #workspaceSyncLocks: MapAsyncLock<string> = mapAsyncLock();
    readonly #workspaceSyncStops = new Map<string, () => void>();
    readonly #workspaceSyncTimers = new Map<string, NodeJS.Timeout>();
    readonly #workspaces: WorkspacesModule;
    readonly #workspacesDirectory: string;

    readonly #avatarContext: Context;
    readonly #branchContext: Context;
    readonly #cleanupContext: Context;
    readonly #projectInitializationContext: Context;
    readonly #syncContext: Context;
    readonly #workspaceInitializationContext: Context;

    #activeInitializations = 0;
    #closed = false;

    constructor(options: ProjectWorkspaceServiceOptions) {
        this.#agentId = options.agentId;
        this.#projects = options.projects;
        this.#workspaces = options.workspaces;
        this.#environment = options.environment ?? process.env;
        this.#cloneRemote = options.cloneRemote ?? cloneRemoteRepository;
        this.#gitCredentialBroker = options.gitCredentialBroker ?? new GitCredentialBroker();
        this.#hasCustomGit = options.git !== undefined;
        this.#git = options.git ?? directGitCommandRunner;
        this.#probeGit = options.probeGit ??
            options.git ?? {
                run: async (cwd, args) => {
                    try {
                        const stdout = await runSandboxedGitCommand(cwd, args, {
                            signal: this.#backgroundAbort.signal,
                        });
                        return { code: 0, stderr: "", stdout };
                    } catch (error) {
                        return { code: 1, stderr: errorToMessage(error), stdout: "" };
                    }
                },
            };
        this.#homeDirectory = normalizeProjectCwd(options.homeDirectory ?? homedir());
        this.#localCreator = options.localCreator;
        this.#localInstanceId = options.localInstanceId;
        this.#managedProjectsDirectory = normalizeFuturePath(
            options.managedProjectsDirectory ??
                getManagedProjectsDirectory(this.#environment, this.#homeDirectory),
        );
        this.#nameGenerator = options.nameGenerator;
        this.#now = options.now ?? Date.now;
        this.#onWorkspaceBranchError = options.onWorkspaceBranchError;
        this.#onWorkspaceCleanupError = options.onWorkspaceCleanupError;
        this.#resolveGitSecret = options.resolveGitSecret;
        this.#resolveProfile = options.resolveProfile;
        this.#settings = options.settings ?? DEFAULT_WORKSPACE_FOLDER_SETTINGS;
        this.#stateDirectory = normalizeFuturePath(
            options.stateDirectory ?? join(tmpdir(), `rig-projects-${createId()}`),
        );
        this.#workspacesDirectory = normalizeFuturePath(
            options.workspacesDirectory ??
                getManagedWorkspacesDirectory(this.#environment, this.#homeDirectory),
        );
        this.#avatars = new ProjectAvatarStore(this.#stateDirectory);

        const lifetime = (name: string): Context => {
            const named = options.rootContext.named(name);
            return options.extendBackgroundContext?.(named) ?? named;
        };
        this.#avatarContext = lifetime("project-avatar-maintenance");
        this.#branchContext = lifetime("workspace-branch-rename");
        this.#cleanupContext = lifetime("workspace-cleanup");
        this.#projectInitializationContext = lifetime("project-initialization");
        this.#syncContext = lifetime("workspace-sync");
        this.#workspaceInitializationContext = lifetime("workspace-initialization");
    }

    get managedProjectsDirectory(): string {
        return this.#managedProjectsDirectory;
    }

    get managedWorkspacesDirectory(): string {
        return this.#workspacesDirectory;
    }

    /** The Git runner other host modules should use for this agent's foreground Git work. */
    get git(): GitCommandRunner {
        return this.#git;
    }

    /**
     * What the workspaces catalog consults before it settles on a folder key or a branch. Pass it
     * as the module's `host` so a rename cannot land on a branch Git already holds.
     */
    get workspaceCatalogHost(): WorkspaceCatalogHost {
        return {
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
        };
    }

    /** The bytes behind a catalog avatar. Give this to `ProjectsModule` as its asset reader. */
    get avatarAssetReader(): ProjectAvatarAssetReader {
        return { read: async (_ctx, _agentId, hash) => await this.#avatars.read(hash) };
    }

    /**
     * Picks up whatever the last run left unfinished: projects and workspaces still being set up,
     * failures worth another try, sync for every ready workspace, and stale avatar bytes.
     */
    async open(ctx: Context): Promise<void> {
        for (const workspace of await this.listWorkspaces(ctx)) {
            if (workspace.status === "ready") this.#scheduleWorkspaceSync(workspace.projectRef);
        }
        for (const project of await this.listProjects(ctx)) {
            if (project.kind !== "regular" || project.status === "archived") continue;
            if (project.initializationStatus === "initializing") {
                await this.scheduleInitialization(ctx, project.id);
            } else if (
                project.initializationStatus === "failed" &&
                project.initializationAttempt < MAX_PROJECT_INITIALIZATION_RETRIES &&
                existsSync(project.repositoryRef)
            ) {
                await this.#projects.retryInitialization(ctx, this.#agentId, project.id);
                await this.scheduleInitialization(ctx, project.id);
            }
        }
        this.#runInBackground(this.#avatarContext, async (workerCtx) => {
            await this.reconcileInitializingWorkspaces(workerCtx);
            await this.collectAvatarGarbage(workerCtx);
        });
    }

    /** Stops every background lifetime this service started and waits for the ones in flight. */
    async close(_ctx: Context): Promise<void> {
        this.#closed = true;
        this.#backgroundAbort.abort();
        this.#gitCredentialBroker.close();
        this.#pendingInitializations.length = 0;
        for (const controller of this.#workspaceSetupControllers.values()) {
            controller.abort(new Error("Workspace setup stopped because Rig is closing."));
        }
        this.#workspaceSetupControllers.clear();
        for (const timer of this.#workspaceSyncTimers.values()) clearTimeout(timer);
        this.#workspaceSyncTimers.clear();
        for (const stop of this.#workspaceSyncStops.values()) stop();
        this.#workspaceSyncStops.clear();
        while (this.#tasks.size > 0) {
            await Promise.allSettled([...this.#tasks]);
        }
    }

    // --- Reading -------------------------------------------------------------------------

    async getProject(ctx: Context, projectId: string): Promise<Project | undefined> {
        return this.#remember(await this.#projects.get(ctx, this.#agentId, projectId));
    }

    async getProjectByPath(ctx: Context, cwd: string): Promise<Project | undefined> {
        return this.#remember(
            await this.#projects.getByPath(ctx, this.#agentId, normalizeProjectCwd(cwd)),
        );
    }

    async listProjects(ctx: Context): Promise<readonly Project[]> {
        const page = await this.#projects.list(ctx, this.#agentId, { includeArchived: true });
        for (const project of page.projects) this.#remember(project);
        return page.projects;
    }

    async listWorkspaces(ctx: Context, projectId?: string): Promise<readonly Workspace[]> {
        return await this.#workspaces.list(ctx, this.#agentId, {
            includeArchived: true,
            ...(projectId === undefined ? {} : { projectRef: projectId }),
        });
    }

    async getWorkspace(
        ctx: Context,
        projectId: string,
        workspaceId: string,
    ): Promise<Workspace | undefined> {
        const workspace = await this.#workspaces.get(ctx, this.#agentId, workspaceId);
        return workspace?.projectRef === projectId ? workspace : undefined;
    }

    async queryProjectSettings(
        ctx: Context,
        cwd: string,
    ): Promise<ProjectSessionSettings | undefined> {
        const path = normalizeProjectCwd(cwd);
        const workspace = await this.#workspaces.getByPath(ctx, this.#agentId, path);
        const projectId =
            workspace === undefined
                ? (await this.getProjectByPath(ctx, path))?.id
                : workspace.projectRef;
        if (projectId === undefined) return undefined;
        const settings = await this.#projects.readSettings(ctx, this.#agentId, projectId);
        return {
            projectId,
            settings,
            ...(workspace === undefined ? {} : { workspaceId: workspace.id }),
        };
    }

    async setProjectSettings(
        ctx: Context,
        projectId: string,
        settings: ProjectSettingsUpdateInput["settings"],
        expectedVersion?: number,
    ): Promise<Project | undefined> {
        await this.#projects.updateSettings(ctx, this.#agentId, {
            projectId,
            settings,
            ...(expectedVersion === undefined ? {} : { expectedVersion }),
        });
        return await this.getProject(ctx, projectId);
    }

    // --- Ownership and registration ------------------------------------------------------

    /**
     * Finds what owns a directory, importing the directory as a project if it is new.
     *
     * `requestedProjectId` names that import. A project is a folder, so a folder Rig already knows
     * keeps the identity it has and the request is simply answered with it; the requested identity
     * only takes effect for a folder that becomes a project now.
     */
    async resolve(
        ctx: Context,
        cwd: string,
        assertedWorkspaceId?: string,
        requestedProjectId?: string,
    ): Promise<ResolvedProjectOwnership> {
        return await this.#resolvePath(
            ctx,
            normalizeProjectCwd(cwd),
            assertedWorkspaceId,
            requestedProjectId,
        );
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
        const path = normalizeProjectCwd(cwd);
        const workspace = await this.#workspaces.get(ctx, this.#agentId, workspaceId);
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
        const project = await this.getProject(ctx, workspace.projectRef);
        if (project === undefined) {
            throw new ProjectRegistrationError(
                "managed_workspace_unavailable",
                "The workspace's project was not found.",
            );
        }
        return { project: (await this.unarchiveProject(ctx, project.id)) ?? project, workspace };
    }

    /**
     * Adds one explicit Git project without starting a session. Validation happens before the
     * shared folder import, so a registered project is always the canonical root of a working tree.
     */
    async registerProject(
        ctx: Context,
        request: { path: string; projectId?: string },
    ): Promise<Project> {
        if (!isAbsolute(request.path)) {
            throw new ProjectRegistrationError(
                "invalid_request",
                "The project path must be absolute.",
            );
        }
        if (request.projectId !== undefined) clientChosenProjectId(request.projectId);
        const path = await validateRegistrationPath(this.#git, request.path);
        return (await this.#resolvePath(ctx, path, undefined, request.projectId)).project;
    }

    async #resolvePath(
        ctx: Context,
        path: string,
        assertedWorkspaceId?: string,
        requestedProjectId?: string,
    ): Promise<ResolvedProjectOwnership> {
        const workspace = await this.#workspaces.getByPath(ctx, this.#agentId, path);
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
            const project = await this.getProject(ctx, workspace.projectRef);
            if (project === undefined) {
                throw new ProjectRegistrationError(
                    "managed_workspace_unavailable",
                    "The workspace's project was not found.",
                );
            }
            return {
                project: (await this.unarchiveProject(ctx, project.id)) ?? project,
                workspace,
            };
        }
        if (assertedWorkspaceId !== undefined) {
            throw new Error("The workspace ID does not match the session directory.");
        }

        const importedId =
            requestedProjectId === undefined
                ? undefined
                : clientChosenId(requestedProjectId, "project");
        const existing = await this.getProjectByPath(ctx, path);
        if (existing !== undefined) {
            // A project is only a folder, so working in it again is what brings it back: starting
            // a session restores an archived project instead of asking someone to unarchive it.
            if (importedId !== undefined && importedId !== existing.id) {
                await this.#assertUnusedProjectId(ctx, importedId, path);
            }
            return { project: (await this.unarchiveProject(ctx, existing.id)) ?? existing };
        }
        if (importedId !== undefined) await this.#assertUnusedProjectId(ctx, importedId, path);

        const kind = path === this.#homeDirectory ? "home" : "regular";
        const project = this.#remember(
            await this.#projects.create(ctx, this.#agentId, {
                ...(importedId === undefined ? {} : { id: importedId }),
                repositoryRef: path,
                kind,
                name: kind === "home" ? HOME_PROJECT_NAME : folderProjectName(path),
            }),
        );
        if (project === undefined) throw new Error("The project could not be created.");
        if (kind === "regular") await this.scheduleInitialization(ctx, project.id);
        return { project };
    }

    /** Refuses a client-chosen project identity that already names another folder. */
    async #assertUnusedProjectId(ctx: Context, id: string, path: string): Promise<void> {
        const known = await this.#projects.get(ctx, this.#agentId, id);
        if (known !== undefined && known.repositoryRef !== path) {
            throw new ProjectRegistrationError(
                "project_id_conflict",
                "That project ID already names another folder.",
            );
        }
    }

    // --- Project lifecycle ---------------------------------------------------------------

    async renameProject(
        ctx: Context,
        projectId: string,
        requestedName: string,
        expectedVersion?: number,
    ): Promise<Project | undefined> {
        if ((await this.getProject(ctx, projectId)) === undefined) return undefined;
        return this.#remember(
            await this.#projects.rename(ctx, this.#agentId, {
                projectId,
                name: validateProjectName(requestedName),
                ...(expectedVersion === undefined ? {} : { expectedVersion }),
            }),
        );
    }

    async reorderProject(
        ctx: Context,
        projectId: string,
        afterId: string | null,
        expectedVersion?: number,
    ): Promise<Project | undefined> {
        if ((await this.getProject(ctx, projectId)) === undefined) return undefined;
        return this.#remember(
            await this.#projects.reorder(ctx, this.#agentId, {
                projectId,
                afterId,
                ...(expectedVersion === undefined ? {} : { expectedVersion }),
            }),
        );
    }

    /**
     * Archives a project and everything cut from it. Archival is the immediate decision; removing
     * the workspaces' folders is background cleanup that never takes the decision back.
     */
    async archiveProject(ctx: Context, projectId: string): Promise<Project | undefined> {
        const project = await this.getProject(ctx, projectId);
        if (project === undefined) return undefined;
        if (project.status === "archived") return project;
        const workspaces = (await this.listWorkspaces(ctx, projectId)).filter(
            (workspace) => workspace.status !== "archived" && workspace.status !== "archiving",
        );
        for (const workspace of workspaces) {
            await this.beginWorkspaceArchive(ctx, projectId, workspace.id);
        }
        const archived = this.#remember(
            await this.#projects.archive(ctx, this.#agentId, projectId),
        );
        this.#gitCredentialBroker.revoke(projectId);
        this.#runInBackground(this.#cleanupContext, async (workerCtx) => {
            for (const workspace of workspaces) {
                await this.removeArchivedWorkspace(workerCtx, projectId, workspace.id);
            }
        });
        return archived;
    }

    async unarchiveProject(ctx: Context, projectId: string): Promise<Project | undefined> {
        const project = await this.getProject(ctx, projectId);
        if (project === undefined || project.status !== "archived") return project;
        return this.#remember(await this.#projects.restore(ctx, this.#agentId, projectId));
    }

    async refreshProject(ctx: Context, projectId: string): Promise<Project | undefined> {
        const project = await this.getProject(ctx, projectId);
        if (project === undefined) return undefined;
        if (project.kind === "home") {
            throw new Error("The Home project does not need to be set up.");
        }
        const refreshed = this.#remember(
            await this.#projects.refresh(ctx, this.#agentId, projectId),
        );
        await this.scheduleInitialization(ctx, projectId);
        return refreshed;
    }

    async scheduleInitialization(ctx: Context, projectId: string): Promise<void> {
        if (this.#closed || this.#initializing.has(projectId)) return;
        const project = await this.getProject(ctx, projectId);
        if (project === undefined) return;
        if (!existsSync(project.repositoryRef) && project.remoteSource === undefined) {
            await this.#failProjectInitialization(
                ctx,
                projectId,
                "The project folder is not available.",
            );
            return;
        }
        this.#initializing.add(projectId);
        this.#pendingInitializations.push(projectId);
        setImmediate(() => {
            this.#drainInitializations();
        });
    }

    #drainInitializations(): void {
        if (this.#closed) return;
        while (this.#activeInitializations < 2) {
            const projectId = this.#pendingInitializations.shift();
            if (projectId === undefined) return;
            this.#activeInitializations += 1;
            this.#runInBackground(this.#projectInitializationContext, async (workerCtx) => {
                try {
                    await this.#initializeProject(workerCtx, projectId);
                } finally {
                    this.#activeInitializations -= 1;
                    this.#initializing.delete(projectId);
                    if (!this.#closed) this.#drainInitializations();
                }
            });
        }
    }

    async #initializeProject(ctx: Context, projectId: string): Promise<void> {
        if (this.#closed) return;
        const project = await this.getProject(ctx, projectId);
        if (
            project === undefined ||
            project.kind === "home" ||
            project.initializationStatus !== "initializing"
        ) {
            return;
        }
        try {
            if (project.remoteSource !== undefined) {
                await this.#cloneRemoteProject(ctx, project);
                if (this.#closed) return;
            }
            // A new project learns its presence and worktree capability here rather than waiting
            // for the next start, because a client offers "Create workspace" immediately.
            await this.#reconcileProjectGitFacts(ctx, project);
            if (this.#closed) return;

            let remote: string | undefined;
            let repositoryTopLevel = false;
            try {
                repositoryTopLevel =
                    (await readGitTopLevel(this.#git, project.repositoryRef)) ===
                    project.repositoryRef;
                if (repositoryTopLevel) {
                    remote = await selectGitRemoteUrl(this.#git, project.repositoryRef);
                }
            } catch {
                // A regular folder without Git is a perfectly good project.
            }
            if (this.#closed) return;

            // The trunk is decided while the project is being added, so every later workspace has
            // a branch to fork without re-deciding it under someone's request. Git resolves upward
            // from a folder, so this waits until the folder is known to be a repository root and a
            // plain directory inside somebody else's repository cannot inherit their branch.
            if (repositoryTopLevel) await this.#projectDefaultBranch(ctx, project);
            if (this.#closed) return;

            const detectedName = remote === undefined ? undefined : remoteProjectName(remote);
            const current = await this.getProject(ctx, projectId);
            if (current === undefined) return;
            if (detectedName !== undefined && current.nameSource === "folder") {
                this.#remember(
                    await this.#projects.adoptRemoteName(ctx, this.#agentId, {
                        projectId,
                        name: detectedName,
                    }),
                );
            }

            if ((await this.getProject(ctx, projectId))?.avatar === undefined) {
                const repositoryAvatar = repositoryTopLevel
                    ? await findRepositoryAvatar(project.repositoryRef)
                    : undefined;
                const hostingAvatar =
                    repositoryAvatar === undefined && remote !== undefined
                        ? await findHostingAvatar(remote)
                        : undefined;
                const candidate = repositoryAvatar ?? hostingAvatar;
                if (this.#closed) return;
                if (
                    candidate !== undefined &&
                    (await this.getProject(ctx, projectId))?.avatar === undefined
                ) {
                    await this.setAvatar(
                        ctx,
                        projectId,
                        repositoryAvatar === undefined ? "hosting" : "repository",
                        candidate,
                    );
                }
            }
            if (this.#closed) return;

            this.#remember(
                await this.#projects.markInitializationReady(ctx, this.#agentId, projectId),
            );
        } catch (error) {
            if (this.#closed) return;
            await this.#failProjectInitialization(ctx, projectId, errorToMessage(error));
        }
    }

    async #failProjectInitialization(
        ctx: Context,
        projectId: string,
        message: string,
    ): Promise<void> {
        this.#remember(
            await this.#projects.markInitializationFailed(ctx, this.#agentId, {
                projectId,
                error: boundedError(message),
            }),
        );
    }

    /**
     * Reads the branch a project's workspaces are cut from, detecting and recording it on first
     * use so a project added before detection existed still forks from the trunk.
     */
    async #projectDefaultBranch(ctx: Context, project: Project): Promise<string | undefined> {
        if (project.defaultBranch !== undefined) return project.defaultBranch;
        const detected = await detectGitDefaultBranch(this.#git, project.repositoryRef);
        if (detected === undefined || this.#closed) return detected;
        const updated = this.#remember(
            await this.#projects.setDefaultBranch(ctx, this.#agentId, {
                projectId: project.id,
                branch: detected,
            }),
        );
        // Another path may have recorded a different branch first. The stored decision is the one
        // the project publishes, so it is also the one a workspace has to be cut from.
        return updated?.defaultBranch ?? detected;
    }

    // --- Remote projects and credentials -------------------------------------------------

    async createRemoteProject(
        ctx: Context,
        request: CreateRemoteProjectRequest,
        options: { createdBy?: ProjectCreator; githubToken?: string } = {},
    ): Promise<Project> {
        const name = validateManagedProjectFolderName(request.name);
        const creator = options.createdBy ?? this.#localCreator;
        if (creator === undefined) {
            throw new ProjectRegistrationError(
                "invalid_request",
                "A person's profile is required to create a managed project.",
            );
        }
        if (request.secret !== undefined && request.source.kind !== "github") {
            throw new ProjectRegistrationError(
                "unsupported_git_source",
                "GitHub credentials can only be used with a GitHub repository.",
            );
        }
        const id =
            request.projectId === undefined ? createId() : clientChosenProjectId(request.projectId);
        const path = normalizeFuturePath(join(this.#managedProjectsDirectory, name));
        const githubToken =
            options.githubToken ??
            (request.secret?.kind === "github" && creator.instanceId === this.#localInstanceId
                ? this.#localGitSecret("github")
                : undefined);
        if (githubToken !== undefined && request.source.kind !== "github") {
            throw new ProjectRegistrationError(
                "unsupported_git_source",
                "GitHub credentials can only be used with a GitHub repository.",
            );
        }
        const registerCredential = async (): Promise<void> => {
            if (githubToken === undefined || request.source.kind !== "github") return;
            await this.#gitCredentialBroker.register({
                creator,
                projectId: id,
                repository: request.source.repository,
                token: githubToken,
            });
        };

        const retried = await this.#retriedRemoteProject(ctx, id, path, request, creator);
        if (retried !== undefined) {
            this.#creators.set(id, creator);
            await registerCredential();
            const canRetry =
                retried.requiredSecretKind !== "github" ||
                this.gitAuthentication(retried.id, creator) !== undefined;
            if (retried.initializationStatus === "failed" && !canRetry) return retried;
            if (retried.initializationStatus === "failed") {
                await this.#projects.retryInitialization(ctx, this.#agentId, id);
            }
            if (retried.initializationStatus !== "ready" && canRetry) {
                await this.scheduleInitialization(ctx, id);
            }
            return (await this.getProject(ctx, id)) ?? retried;
        }
        if ((await this.getProjectByPath(ctx, path)) !== undefined) {
            throw new ProjectRegistrationError(
                "project_path_conflict",
                "That managed project folder already belongs to another project.",
            );
        }
        if (existsSync(path)) {
            throw new ProjectRegistrationError(
                "project_path_conflict",
                "That managed project folder already exists.",
            );
        }
        await mkdir(this.#managedProjectsDirectory, { recursive: true });
        this.#creators.set(id, creator);
        await registerCredential();
        try {
            const project = this.#remember(
                await this.#projects.create(ctx, this.#agentId, {
                    id,
                    repositoryRef: path,
                    kind: "regular",
                    name,
                    remoteSource: request.source,
                    ...(request.secret === undefined
                        ? {}
                        : { requiredSecretKind: request.secret.kind }),
                }),
            );
            if (project === undefined) throw new Error("The remote project could not be created.");
            await this.scheduleInitialization(ctx, id);
            return project;
        } catch (error) {
            const raced = await this.#retriedRemoteProject(ctx, id, path, request, creator);
            if (raced !== undefined) {
                if (raced.initializationStatus !== "ready") {
                    await this.scheduleInitialization(ctx, id);
                }
                return raced;
            }
            this.#gitCredentialBroker.revoke(id);
            this.#creators.delete(id);
            if ((await this.getProjectByPath(ctx, path)) !== undefined) {
                throw new ProjectRegistrationError(
                    "project_path_conflict",
                    "That managed project folder already belongs to another project.",
                );
            }
            throw error;
        }
    }

    async #retriedRemoteProject(
        ctx: Context,
        id: string,
        path: string,
        request: CreateRemoteProjectRequest,
        creator: ProjectCreator,
    ): Promise<Project | undefined> {
        const project = await this.getProject(ctx, id);
        if (project === undefined) return undefined;
        const recordedCreator = this.#creators.get(id);
        if (
            project.repositoryRef !== path ||
            !remoteProjectSourcesEqual(project.remoteSource, request.source) ||
            project.requiredSecretKind !== request.secret?.kind ||
            (recordedCreator !== undefined &&
                (recordedCreator.instanceId !== creator.instanceId ||
                    recordedCreator.profileId !== creator.profileId))
        ) {
            throw new ProjectRegistrationError(
                "project_id_conflict",
                "That project ID already names a different project.",
            );
        }
        return project;
    }

    async #cloneRemoteProject(ctx: Context, project: Project): Promise<void> {
        if (project.remoteSource === undefined) return;
        const stagingRoot = join(this.#managedProjectsDirectory, ".rig", "clones");
        const stagingPath = join(stagingRoot, project.id);
        if (existsSync(project.repositoryRef)) {
            const topLevel = await readGitTopLevel(this.#probeGit, project.repositoryRef);
            if (topLevel !== project.repositoryRef) {
                throw new Error("The managed project folder is not the expected Git repository.");
            }
            const origin = await this.#probeGit.run(project.repositoryRef, [
                "remote",
                "get-url",
                "origin",
            ]);
            if (!remoteSourceUrlMatches(origin.stdout.trim(), project.remoteSource)) {
                throw new Error("The managed project folder has a different origin repository.");
            }
            this.#remember(await this.#projects.markCloneReady(ctx, this.#agentId, project.id));
            return;
        }
        const creator = this.#creators.get(project.id) ?? this.#localCreator;
        if (creator === undefined) {
            throw new Error(
                "This project has no known creator, so its repository cannot be cloned. Add it again from the machine that created it.",
            );
        }
        const profile = await this.#resolveProfile?.(creator.profileId);
        if (profile === undefined || profile.parentInstanceId !== creator.instanceId) {
            throw new Error("The project creator's profile is unavailable.");
        }
        const gitAuthentication = this.#gitCredentialBroker.daemonAuthentication(
            project.id,
            creator,
        );
        if (project.requiredSecretKind === "github" && gitAuthentication === undefined) {
            throw new Error(
                "GitHub credentials are unavailable. Try this project again once GitHub is connected.",
            );
        }
        await mkdir(stagingRoot, { recursive: true });
        await rm(stagingPath, { force: true, recursive: true });
        try {
            await this.#cloneRemote({
                destination: stagingPath,
                ...(gitAuthentication === undefined ? {} : { gitAuthentication }),
                gitIdentity: { email: profile.email, name: profile.name },
                source: project.remoteSource,
            });
            if ((await readGitTopLevel(this.#git, stagingPath)) !== stagingPath) {
                throw new Error("The cloned folder is not a Git repository root.");
            }
            if (existsSync(project.repositoryRef)) {
                throw new Error("The managed project folder appeared while cloning.");
            }
            await rename(stagingPath, project.repositoryRef);
            this.#remember(await this.#projects.markCloneReady(ctx, this.#agentId, project.id));
        } finally {
            await rm(stagingPath, { force: true, recursive: true });
        }
    }

    async registerGitCredential(
        ctx: Context,
        projectId: string,
        creator: ProjectCreator,
        githubToken: string,
    ): Promise<GitAuthentication> {
        const project = await this.getProject(ctx, projectId);
        if (project?.remoteSource?.kind !== "github") {
            throw new Error("GitHub credentials can only be used with a GitHub project.");
        }
        this.#creators.set(projectId, creator);
        return await this.#gitCredentialBroker.register({
            creator,
            projectId,
            repository: project.remoteSource.repository,
            token: githubToken,
        });
    }

    async refreshGitCredential(
        ctx: Context,
        projectId: string,
        creator: ProjectCreator,
        githubToken: string,
    ): Promise<GitAuthentication> {
        const project = await this.getProject(ctx, projectId);
        if (project?.remoteSource?.kind !== "github") {
            throw new Error("That profile does not own a managed GitHub project.");
        }
        const recorded = this.#creators.get(projectId);
        if (
            recorded !== undefined &&
            (recorded.instanceId !== creator.instanceId || recorded.profileId !== creator.profileId)
        ) {
            throw new Error("That profile does not own a managed GitHub project.");
        }
        const authentication = await this.registerGitCredential(
            ctx,
            projectId,
            creator,
            githubToken,
        );
        if (project.initializationStatus === "failed") {
            await this.#projects.retryInitialization(ctx, this.#agentId, projectId);
            await this.scheduleInitialization(ctx, projectId);
        }
        return authentication;
    }

    gitAuthentication(
        projectId: string,
        creator: ProjectCreator,
    ): ReturnType<GitCredentialBroker["authentication"]> {
        return this.#gitCredentialBroker.authentication(projectId, creator);
    }

    /** Re-registers the local credential for every managed project and retries what failed. */
    async retryRemoteProjects(ctx: Context, kind: "github"): Promise<void> {
        const token = this.#localGitSecret(kind);
        if (token === undefined) return;
        for (const project of await this.listProjects(ctx)) {
            if (project.requiredSecretKind !== kind) continue;
            if (project.remoteSource?.kind !== "github") continue;
            const creator = this.#creators.get(project.id) ?? this.#localCreator;
            if (creator === undefined || creator.instanceId !== this.#localInstanceId) continue;
            try {
                await this.#gitCredentialBroker.register({
                    creator,
                    projectId: project.id,
                    repository: project.remoteSource.repository,
                    token,
                });
            } catch {
                continue;
            }
            if (this.#closed) return;
            if (project.initializationStatus === "failed") {
                await this.#projects.retryInitialization(ctx, this.#agentId, project.id);
            }
            await this.scheduleInitialization(ctx, project.id);
        }
    }

    #localGitSecret(kind: "github"): string | undefined {
        try {
            return this.#resolveGitSecret?.(kind);
        } catch {
            return undefined;
        }
    }

    #gitForProject(projectId: string): GitCommandRunner {
        const creator = this.#creators.get(projectId) ?? this.#localCreator;
        if (this.#hasCustomGit || creator === undefined) return this.#git;
        const authentication = this.#gitCredentialBroker.daemonAuthentication(projectId, creator);
        if (authentication === undefined) return this.#git;
        return {
            run: async (cwd, args, options) =>
                await runGitCommandWithEnvironment(
                    cwd,
                    args,
                    {
                        GIT_CONFIG_GLOBAL: "/dev/null",
                        GIT_CONFIG_NOSYSTEM: "1",
                        ...authentication.environment,
                    },
                    options,
                ),
        };
    }

    // --- Avatars -------------------------------------------------------------------------

    async setAvatar(
        ctx: Context,
        projectId: string,
        source: ProjectAvatarSource,
        bytes: Buffer,
        expectedVersion?: number,
    ): Promise<Project | undefined> {
        const project = await this.getProject(ctx, projectId);
        if (project === undefined) return undefined;
        if (bytes.byteLength > MAX_AVATAR_BYTES) {
            throw new Error("The project image is larger than the allowed limit.");
        }
        const normalized = await normalizeProjectAvatar(bytes);
        return await this.#avatarLocks.runInLock(ctx, normalized.hash, async () => {
            await this.#avatars.write(normalized.hash, normalized.bytes);
            if (this.#closed) return project;
            try {
                return this.#remember(
                    await this.#projects.setAvatar(ctx, this.#agentId, {
                        projectId,
                        avatar: {
                            hash: normalized.hash,
                            height: normalized.height,
                            mediaType: "image/webp",
                            source,
                            url: `/v0/projects/avatars/${normalized.hash}`,
                            width: normalized.width,
                        },
                        ...(expectedVersion === undefined ? {} : { expectedVersion }),
                    }),
                );
            } catch (error) {
                await this.#avatars.remove(normalized.hash);
                throw error;
            }
        });
    }

    async clearAvatar(ctx: Context, projectId: string): Promise<Project | undefined> {
        const project = await this.getProject(ctx, projectId);
        if (project === undefined) return undefined;
        const cleared = this.#remember(
            await this.#projects.clearAvatar(ctx, this.#agentId, { projectId }),
        );
        if (cleared?.kind === "regular") await this.scheduleInitialization(ctx, projectId);
        return cleared;
    }

    async avatarAsset(
        ctx: Context,
        hash: string,
    ): Promise<Awaited<ReturnType<ProjectsModule["avatarAsset"]>>> {
        return await this.#projects.avatarAsset(ctx, this.#agentId, hash);
    }

    /** Removes stored avatar bytes no project has pointed at for a day. */
    async collectAvatarGarbage(ctx: Context): Promise<void> {
        if (this.#closed) return;
        const referenced = new Set(
            (await this.listProjects(ctx))
                .map((project) => project.avatar?.hash)
                .filter((hash): hash is string => hash !== undefined),
        );
        await collectProjectAvatarGarbage({
            now: this.#now(),
            referencedHashes: referenced,
            root: this.#avatars.root,
            stopped: () => this.#closed,
            store: this.#avatars,
        });
    }

    // --- Workspaces ----------------------------------------------------------------------

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
        options: { createdBy?: ProjectCreator; githubToken?: string } = {},
    ): Promise<Workspace | undefined> {
        const project = await this.getProject(ctx, projectId);
        if (project === undefined) return undefined;
        if (request.secret !== undefined && project.remoteSource?.kind !== "github") {
            throw new Error("GitHub credentials can only be used with a GitHub project.");
        }
        const name = validateProjectName(request.name);
        const requestedId =
            request.id === undefined ? undefined : clientChosenId(request.id, "workspace");
        const baseRef = requestedBaseRef(request.baseRef);
        const creator = options.createdBy ?? this.#localCreator;
        if (options.githubToken !== undefined && creator !== undefined) {
            await this.registerGitCredential(ctx, projectId, creator, options.githubToken);
        }
        if (
            project.requiredSecretKind === "github" &&
            (creator === undefined || this.gitAuthentication(projectId, creator) === undefined)
        ) {
            throw new Error("GitHub credentials are unavailable for this workspace.");
        }

        const kind = await this.#workspaceKindFor(ctx, project);
        const workspaceRoot = this.#workspaceRoot(projectId);
        const workspaceId = requestedId ?? createId();
        const gitRefs = workspaceGitRefSnapshot(project.repositoryRef);
        const fallbackStorageKey = `${projectStorageKey(name).slice(0, 20)}-${workspaceId}`;

        const reserved = await this.#workspaces.reserve(
            ctx,
            this.#agentId,
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
            this.#runInBackground(this.#workspaceInitializationContext, async (workerCtx) => {
                await this.#initializeWorkspace(workerCtx, workspace);
            });
        }
        return reserved.workspace;
    }

    /** A project Git cannot cut a worktree from still gets a workspace: a copy of the folder. */
    async #workspaceKindFor(ctx: Context, project: Project): Promise<"git_worktree" | "directory"> {
        if (project.worktreeSupport === "supported") return "git_worktree";
        if (project.worktreeSupport === "unsupported") return "directory";
        const probe = await probeGitRepository({
            git: this.#probeGit,
            isHome: project.kind === "home",
            path: project.repositoryRef,
        });
        await this.#applyProjectProbe(ctx, project.id, probe);
        return probe.worktreeSupport === "supported" ? "git_worktree" : "directory";
    }

    #workspaceRoot(projectId: string): string {
        const storageKey = this.#projectFolders.get(projectId)?.storageKey ?? projectId;
        return join(this.#workspacesDirectory, storageKey);
    }

    async reconcileInitializingWorkspaces(ctx: Context): Promise<void> {
        const workspaces = (await this.listWorkspaces(ctx)).filter(
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
            const project = await this.getProject(ctx, workspace.projectRef);
            if (project === undefined) {
                await this.#failWorkspaceInitialization(
                    ctx,
                    workspace.id,
                    "The workspace's project was not found.",
                );
                return;
            }
            try {
                const current = await this.#projectLocks.runInLock(
                    ctx,
                    workspace.projectRef,
                    async () => await this.#createWorkspaceContentsLocked(ctx, workspace, project),
                );
                if (current === undefined || this.#closed) return;
                await this.#setupWorkspace(ctx, current);
                if (this.#closed) return;
                await this.#workspaces.markReady(ctx, this.#agentId, { workspaceId: current.id });
                this.#scheduleWorkspaceSync(current.projectRef);
            } catch (error) {
                if (this.#closed) return;
                await this.#failWorkspaceInitialization(ctx, workspace.id, errorToMessage(error));
            }
        });
    }

    /** Everything that must happen while this project's Git lock is held. */
    async #createWorkspaceContentsLocked(
        ctx: Context,
        workspace: Workspace,
        project: Project,
    ): Promise<Workspace | undefined> {
        let locked = await this.getWorkspace(ctx, workspace.projectRef, workspace.id);
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

        locked = await this.#prepareWorkspaceInitialization(ctx, locked, project);
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
        await this.#createWorkspaceCheckoutLocked(
            ctx,
            locked,
            project.repositoryRef,
            locked.baseCommit,
        );
        return locked;
    }

    async #prepareWorkspaceInitialization(
        ctx: Context,
        workspace: Workspace,
        project: Project,
    ): Promise<Workspace | undefined> {
        if (workspace.baseCommit !== undefined && workspace.gitCommonDir !== undefined) {
            return workspace;
        }
        const creator = this.#creators.get(project.id) ?? this.#localCreator;
        if (
            project.requiredSecretKind === "github" &&
            (creator === undefined || this.gitAuthentication(project.id, creator) === undefined)
        ) {
            throw new Error(
                "GitHub credentials are unavailable. Try this workspace again from the machine that created the project.",
            );
        }
        const git = this.#gitForProject(project.id);
        if ((await readGitTopLevel(git, project.repositoryRef)) !== project.repositoryRef) {
            throw new Error("A workspace worktree needs a Git repository project.");
        }
        const defaultBranch =
            workspace.baseRef === undefined
                ? await this.#projectDefaultBranch(ctx, project)
                : undefined;
        const gitCommonDir = await readGitCommonDir(git, project.repositoryRef);
        const base = await resolveWorkspaceBase({
            ...(defaultBranch === undefined ? {} : { defaultBranch }),
            git,
            projectPath: project.repositoryRef,
            ...(workspace.baseRef === undefined ? {} : { requestedRef: workspace.baseRef }),
        });
        if (this.#closed) return undefined;
        return await this.#workspaces.recordInitialization(ctx, this.#agentId, {
            workspaceId: workspace.id,
            facts: { baseCommit: base.commit, baseRef: base.ref, gitCommonDir },
        });
    }

    async #createWorkspaceCheckoutLocked(
        ctx: Context,
        workspace: Workspace,
        projectPath: string,
        commit: string,
    ): Promise<void> {
        if (this.#closed) return;
        // The branch may already have followed a rename made while the checkout was reserved.
        const branch =
            (await this.getWorkspace(ctx, workspace.projectRef, workspace.id))?.branch ??
            workspace.branch;
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
        const stored = await this.getWorkspace(ctx, workspace.projectRef, workspace.id);
        if (stored === undefined || stored.branch === branch) return;
        await this.#workspaces.setBranch(ctx, this.#agentId, {
            workspaceId: workspace.id,
            branch,
        });
        this.#onWorkspaceBranchError?.(
            new Error(
                `The workspace was renamed while it was being created, so its branch stayed "${branch}".`,
            ),
            workspace.projectRef,
            workspace.id,
        );
    }

    async #setupWorkspace(ctx: Context, workspace: Workspace): Promise<void> {
        const controller = new AbortController();
        this.#workspaceSetupControllers.set(workspace.id, controller);
        try {
            if (
                (await this.getWorkspace(ctx, workspace.projectRef, workspace.id))?.status !==
                "initializing"
            ) {
                return;
            }
            const project = await this.getProject(ctx, workspace.projectRef);
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
            if (this.#workspaceSetupControllers.get(workspace.id) === controller) {
                this.#workspaceSetupControllers.delete(workspace.id);
            }
        }
    }

    async #failWorkspaceInitialization(
        ctx: Context,
        workspaceId: string,
        message: string,
    ): Promise<void> {
        await this.#workspaces.markInitializationFailed(ctx, this.#agentId, {
            workspaceId,
            error: boundedError(message),
        });
    }

    async #folderSettings(folder: string): Promise<WorkspaceFolderSettings> {
        return await loadWorkspaceFolderSettings(folder, this.#settings);
    }

    // --- Naming, ordering, archival ------------------------------------------------------

    async renameWorkspace(
        ctx: Context,
        projectId: string,
        workspaceId: string,
        requestedName: string,
        expectedVersion?: number,
    ): Promise<Workspace | undefined> {
        const current = await this.getWorkspace(ctx, projectId, workspaceId);
        if (current === undefined) return undefined;
        const renamed = await this.#workspaces.rename(ctx, this.#agentId, {
            workspaceId,
            name: validateProjectName(requestedName),
            ...(expectedVersion === undefined ? {} : { expectedVersion }),
        });
        this.#moveWorkspaceBranch(current, renamed.branch);
        return renamed;
    }

    /**
     * Gives a workspace the name its first chat arrived at. A workspace someone has already named
     * keeps that name.
     */
    async inheritWorkspaceName(
        ctx: Context,
        projectId: string,
        workspaceId: string,
        requestedName: string,
    ): Promise<Workspace | undefined> {
        const current = await this.getWorkspace(ctx, projectId, workspaceId);
        if (current === undefined) return undefined;
        const named = await this.#workspaces.inheritName(ctx, this.#agentId, {
            workspaceId,
            name: validateProjectName(requestedName),
        });
        this.#moveWorkspaceBranch(current, named.branch);
        return named;
    }

    /**
     * Names a workspace and its chat from the first thing someone said.
     *
     * The three names are asked for separately, before the session's own work starts, because a
     * folder, a conversation and a Git ref are different questions. A workspace or a chat someone
     * has already named is left alone: a person naming something settles it.
     */
    async nameFromFirstMessage(
        ctx: Context,
        request: {
            firstMessage: string;
            projectId: string;
            providerId?: string;
            sessionNamed?: boolean;
            workspaceId: string;
        },
    ): Promise<{ branch?: string; chat?: string; workspace?: Workspace }> {
        const generator = this.#nameGenerator;
        if (generator === undefined) return {};
        const current = await this.getWorkspace(ctx, request.projectId, request.workspaceId);
        if (current === undefined) return {};
        const wantWorkspace = !current.nameConfigured;
        const wantChat = request.sessionNamed !== true;
        if (!wantWorkspace && !wantChat) return {};
        const names = await generateWorkspaceNames(
            ctx,
            generator,
            {
                firstMessage: request.firstMessage,
                ...(request.providerId === undefined ? {} : { providerId: request.providerId }),
            },
            { branch: wantWorkspace, chat: wantChat, workspace: wantWorkspace },
        );
        const workspace =
            names.workspace === undefined
                ? undefined
                : await this.inheritWorkspaceName(
                      ctx,
                      request.projectId,
                      request.workspaceId,
                      withPreservedNumericPrefix(current.name, names.workspace),
                  );
        return {
            ...(names.branch === undefined ? {} : { branch: names.branch }),
            ...(names.chat === undefined ? {} : { chat: names.chat }),
            ...(workspace === undefined ? {} : { workspace }),
        };
    }

    /**
     * Moves the worktree's branch to the name the workspace now has.
     *
     * The branch is renamed after the name is durable, because the rename is Git's work and a
     * running agent must not wait for it. Git keeping the old branch is not a failure of the
     * rename the person asked for, so the name stands and the recorded branch goes back to the
     * one Git actually has.
     */
    #moveWorkspaceBranch(previous: Workspace, branch: string | undefined): void {
        if (branch === undefined || branch === previous.branch) return;
        if (previous.status !== "ready") return;
        this.#runInBackground(this.#branchContext, async (workerCtx) => {
            await this.#workspaceLocks.runInLock(workerCtx, previous.id, async () => {
                if (this.#closed) return;
                const workspace = await this.getWorkspace(
                    workerCtx,
                    previous.projectRef,
                    previous.id,
                );
                // A later rename may already have moved the recorded branch past this one, and
                // this hop still runs: that rename starts from this branch, so skipping it would
                // leave Git a step behind with nothing able to catch it up again.
                if (workspace?.status !== "ready" || workspace.gitCommonDir === undefined) return;
                try {
                    // Every worktree of a project shares one set of refs and reflogs, so branch
                    // work takes the project's Git lock the way worktree creation does.
                    await this.#projectLocks.runInLock(workerCtx, previous.projectRef, async () => {
                        await renameGitBranch({
                            expectedCommonDir: workspace.gitCommonDir ?? "",
                            from: previous.branch,
                            git: this.#git,
                            to: branch,
                            workspacePath: workspace.path,
                        });
                    });
                } catch (error) {
                    if (this.#closed) return;
                    // A later rename may already have replaced this one, and it owns the recorded
                    // branch from then on. Reverting here would strand that rename instead.
                    const now = await this.getWorkspace(
                        workerCtx,
                        previous.projectRef,
                        previous.id,
                    );
                    if (now?.branch !== branch) return;
                    this.#onWorkspaceBranchError?.(error, previous.projectRef, previous.id);
                    await this.#workspaces.setBranch(workerCtx, this.#agentId, {
                        workspaceId: previous.id,
                        branch: previous.branch,
                    });
                }
            });
        });
    }

    async reorderWorkspace(
        ctx: Context,
        projectId: string,
        workspaceId: string,
        afterId: string | null,
        expectedVersion?: number,
    ): Promise<Workspace | undefined> {
        if ((await this.getWorkspace(ctx, projectId, workspaceId)) === undefined) return undefined;
        return await this.#workspaces.reorder(ctx, this.#agentId, {
            workspaceId,
            afterId,
            ...(expectedVersion === undefined ? {} : { expectedVersion }),
        });
    }

    /**
     * Archives a workspace. This is the whole decision: the workspace stops being one of the
     * project's workspaces the moment it is made, and removing its folder is separate work that
     * can fail without giving the workspace back.
     */
    async beginWorkspaceArchive(
        ctx: Context,
        projectId: string,
        workspaceId: string,
        expectedVersion?: number,
    ): Promise<Workspace | undefined> {
        const workspace = await this.getWorkspace(ctx, projectId, workspaceId);
        if (workspace === undefined) return undefined;
        if (workspace.status === "archived" || workspace.status === "archiving") {
            this.#stopWorkspaceSetup(workspaceId);
            return workspace;
        }
        const archived = await this.#workspaces.beginArchive(ctx, this.#agentId, workspaceId, {
            ...(expectedVersion === undefined ? {} : { expectedVersion }),
        });
        if (archived.status === "archiving") this.#stopWorkspaceSetup(workspaceId);
        return archived;
    }

    /** Cleans up an archived workspace's folder. Failure is logged; archival still stands. */
    async removeArchivedWorkspace(
        ctx: Context,
        projectId: string,
        workspaceId: string,
    ): Promise<Workspace | undefined> {
        await this.#workspaceLocks.runInLock(ctx, workspaceId, async () => {
            const workspace = await this.getWorkspace(ctx, projectId, workspaceId);
            if (workspace === undefined || workspace.status === "archived") return;
            if (workspace.status !== "archiving") {
                throw new Error("That workspace is not being archived.");
            }
            const project = await this.getProject(ctx, projectId);
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
                this.#onWorkspaceCleanupError?.(error, projectId, workspaceId);
            }
            await this.#workspaces.completeArchive(ctx, this.#agentId, workspaceId);
            // The next pass stops the watch when this was the project's last ready workspace.
            this.#scheduleWorkspaceSync(projectId);
        });
        return await this.getWorkspace(ctx, projectId, workspaceId);
    }

    #stopWorkspaceSetup(workspaceId: string): void {
        this.#workspaceSetupControllers
            .get(workspaceId)
            ?.abort(new Error("Workspace setup stopped because the workspace was archived."));
    }

    // --- Sync ----------------------------------------------------------------------------

    /** Debounces the project's next sync pass, so a burst of file events becomes one copy. */
    #scheduleWorkspaceSync(projectId: string): void {
        if (this.#closed) return;
        clearTimeout(this.#workspaceSyncTimers.get(projectId));
        const timer = setTimeout(() => {
            this.#workspaceSyncTimers.delete(projectId);
            this.#runInBackground(this.#syncContext, async (workerCtx) => {
                await this.#workspaceSyncLocks.runInLock(
                    workerCtx,
                    projectId,
                    async (lockedCtx) => {
                        await this.#runWorkspaceSyncPass(lockedCtx, projectId);
                    },
                );
            });
        }, WORKSPACE_SYNC_DEBOUNCE_MS);
        timer.unref?.();
        this.#workspaceSyncTimers.set(projectId, timer);
    }

    /**
     * Replicates the project root's configured sync paths into every ready workspace, then re-arms
     * the watch from the current configuration. Sync is best-effort: one workspace failing to
     * receive a copy never fails the others, and a project left without ready workspaces simply
     * stops being watched.
     */
    async #runWorkspaceSyncPass(ctx: Context, projectId: string): Promise<void> {
        this.#workspaceSyncStops.get(projectId)?.();
        this.#workspaceSyncStops.delete(projectId);
        if (this.#closed) return;
        const project = await this.getProject(ctx, projectId);
        const workspaces = (await this.listWorkspaces(ctx, projectId)).filter(
            (workspace) => workspace.status === "ready",
        );
        if (project === undefined || workspaces.length === 0) return;
        const settings = await this.#folderSettings(project.repositoryRef);
        const syncPaths = [...new Set([...settings.sync, ...settings.protectedSync])];
        if (this.#closed) return;
        // The watch is armed even with nothing to sync: it also observes the project configuration
        // file, so a sync list added later is picked up without a restart.
        this.#workspaceSyncStops.set(
            projectId,
            watchWorkspaceSyncPaths({
                onChange: () => {
                    this.#scheduleWorkspaceSync(projectId);
                },
                projectPath: project.repositoryRef,
                syncPaths,
            }),
        );
        for (const workspace of workspaces) {
            if (this.#closed) return;
            // Re-read right before copying: a workspace archived while this pass was running must
            // not have its folder written to, much less recreated.
            if ((await this.getWorkspace(ctx, projectId, workspace.id))?.status !== "ready") {
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

    // --- Git facts -----------------------------------------------------------------------

    /**
     * Re-derives presence, worktree capability and Git facts for every live project and workspace.
     * Enrichment only: it writes when something actually changed and stops as soon as Rig closes.
     */
    async reconcileGitFacts(ctx: Context): Promise<void> {
        const projects = (await this.listProjects(ctx)).filter(
            // An archived project is hidden, so re-deriving its Git facts is wasted work.
            (project) => project.status !== "archived",
        );
        const workspaces = (await this.listWorkspaces(ctx)).filter(
            (workspace) => workspace.status === "ready",
        );
        const targets: (
            | { kind: "project"; value: Project }
            | { kind: "workspace"; value: Workspace }
        )[] = [
            ...projects.map((value) => ({ kind: "project" as const, value })),
            ...workspaces.map((value) => ({ kind: "workspace" as const, value })),
        ];
        let next = 0;
        const worker = async (): Promise<void> => {
            for (;;) {
                if (this.#closed) return;
                const target = targets[next++];
                if (target === undefined) return;
                if (target.kind === "project") {
                    await this.#reconcileProjectGitFacts(ctx, target.value);
                } else {
                    await this.#reconcileWorkspaceGitFacts(ctx, target.value);
                }
            }
        };
        await Promise.all(
            Array.from({ length: Math.min(GIT_PROBE_CONCURRENCY, targets.length) }, worker),
        );
    }

    /**
     * Persists Git facts observed by a live scan. Branch, HEAD and upstream are durable state, so
     * a commit or a checkout has to reach clients that are not watching the live stream.
     */
    async applyGitFacts(
        ctx: Context,
        target: { projectId: string; workspaceId?: string },
        facts: GitRepositoryFacts,
    ): Promise<void> {
        if (target.workspaceId === undefined) {
            this.#remember(
                await this.#projects.applyGitFacts(ctx, this.#agentId, {
                    projectId: target.projectId,
                    git: catalogGitFacts(facts),
                }),
            );
            return;
        }
        await this.#workspaces.applyGitFacts(ctx, this.#agentId, {
            workspaceId: target.workspaceId,
            facts: catalogGitFacts(facts),
        });
    }

    /**
     * The seam between the live Git watcher and the catalogs. Give this to `GitStateTracker` as
     * its `onSnapshot`: every scan it finishes lands on the project or workspace it scanned, so a
     * commit made in a terminal shows up for a client that is not watching the live stream.
     *
     * Failures are swallowed on purpose — a scan arriving for a workspace that has just been
     * archived is ordinary, and a watcher is not the place to decide a person sees an error.
     */
    get gitSnapshotObserver(): (
        ctx: Context,
        entity: GitTrackedEntity,
        snapshot: GitChangeSnapshot,
    ) => Promise<void> {
        return async (ctx, entity, snapshot) => {
            if (this.#closed) return;
            try {
                await this.applyGitFacts(
                    ctx,
                    {
                        projectId: entity.projectId,
                        ...(entity.workspaceId === undefined
                            ? {}
                            : { workspaceId: entity.workspaceId }),
                    },
                    snapshot.facts,
                );
            } catch (error) {
                ctx.log?.debug?.(
                    `Git facts from a live scan were not stored: ${errorToMessage(error)}`,
                );
            }
        };
    }

    async #reconcileProjectGitFacts(ctx: Context, project: Project): Promise<void> {
        const probe = await probeGitRepository({
            git: this.#probeGit,
            isHome: project.kind === "home",
            path: project.repositoryRef,
        });
        if (this.#closed) return;
        await this.#applyProjectProbe(ctx, project.id, probe);
    }

    async #applyProjectProbe(
        ctx: Context,
        projectId: string,
        probe: GitRepositoryProbe,
    ): Promise<void> {
        this.#remember(
            await this.#projects.applyProbe(ctx, this.#agentId, {
                projectId,
                presence: probe.presence,
                worktreeSupport: probe.worktreeSupport,
                ...(probe.worktreeSupportReason === undefined
                    ? {}
                    : { worktreeUnsupportedReason: boundedError(probe.worktreeSupportReason) }),
                ...(probe.facts === undefined ? {} : { git: catalogGitFacts(probe.facts) }),
            }),
        );
    }

    async #reconcileWorkspaceGitFacts(ctx: Context, workspace: Workspace): Promise<void> {
        const probe = await probeGitRepository({ git: this.#probeGit, path: workspace.path });
        if (this.#closed) return;
        await this.#workspaces.applyProbe(ctx, this.#agentId, {
            workspaceId: workspace.id,
            presence: probe.presence,
            facts: catalogGitFacts(probe.facts ?? { ahead: 0, behind: 0, detached: false }),
        });
    }

    // --- Session transfer ----------------------------------------------------------------

    async validateSessionTransfer(
        ctx: Context,
        projectId: string,
        sourceWorkspaceId: string,
        targetWorkspaceId: string,
    ): Promise<{ source: Workspace; target: Workspace }> {
        if (sourceWorkspaceId === targetWorkspaceId) {
            throw new Error("Choose a different workspace to move the session into.");
        }
        const source = await this.getWorkspace(ctx, projectId, sourceWorkspaceId);
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
        const target = await this.getWorkspace(ctx, projectId, targetWorkspaceId);
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
        const target = await this.getWorkspace(ctx, projectId, targetWorkspaceId);
        if (target === undefined) return error;
        const failure = new WorkspaceTransferTargetRestoreError(
            error.originalError,
            error.restoreError,
            target.name,
        );
        await this.#workspaces.markFailed(ctx, this.#agentId, {
            workspaceId: targetWorkspaceId,
            error: boundedError(failure.message),
        });
        return failure;
    }

    // --- Internals -----------------------------------------------------------------------

    #remember<T extends Project | undefined>(project: T): T {
        if (project !== undefined) {
            this.#projectFolders.set(project.id, {
                path: project.repositoryRef,
                storageKey: project.storageKey,
            });
        }
        return project;
    }

    /**
     * Starts work that outlives whatever asked for it, on its own named lifetime. The caller's
     * context is deliberately not used: a background checkout must not end when a request does.
     */
    #runInBackground(lifetime: Context, work: (ctx: Context) => Promise<void>): void {
        if (this.#closed) return;
        const task = work(lifetime)
            .catch(() => undefined)
            .finally(() => {
                this.#tasks.delete(task);
            });
        this.#tasks.add(task);
    }
}

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

function catalogGitFacts(facts: GitRepositoryFacts): ProjectGitFacts {
    return {
        ahead: facts.ahead,
        behind: facts.behind,
        detached: facts.detached,
        ...(facts.branch === undefined ? {} : { branch: facts.branch }),
        ...(facts.head === undefined ? {} : { head: facts.head }),
        ...(facts.upstream === undefined ? {} : { upstream: facts.upstream }),
    };
}

function remoteProjectSourcesEqual(
    left: ProjectRemoteSource | undefined,
    right: ProjectRemoteSource,
): boolean {
    if (left?.kind === "github") {
        return right.kind === "github" && left.repository === right.repository;
    }
    return left?.kind === "git" && right.kind === "git" && left.url === right.url;
}

function remoteSourceUrlMatches(actual: string, source: ProjectRemoteSource): boolean {
    try {
        const expected = remoteUrlForSource(source);
        const normalizedActual =
            source.kind === "github"
                ? remoteUrlForSource({
                      kind: "github",
                      repository: githubRepositoryFromUrl(actual),
                  })
                : new URL(actual).toString();
        return source.kind === "github"
            ? normalizedActual.toLowerCase() === expected.toLowerCase()
            : normalizedActual === expected;
    } catch {
        return false;
    }
}

function githubRepositoryFromUrl(value: string): string {
    const url = new URL(value);
    if (
        url.protocol !== "https:" ||
        url.hostname.toLowerCase() !== "github.com" ||
        url.username.length > 0 ||
        url.password.length > 0
    ) {
        throw new Error("The GitHub origin is invalid.");
    }
    const parts = url.pathname
        .replace(/\.git$/u, "")
        .split("/")
        .filter(Boolean);
    if (parts.length !== 2) throw new Error("The GitHub origin is invalid.");
    return `${parts[0] ?? ""}/${parts[1] ?? ""}`;
}

function errorToMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return typeof error === "string" ? error : JSON.stringify(error);
}

function boundedError(message: string): string {
    const cleaned = message.replaceAll("\u0000", " ").trim();
    return (cleaned.length === 0 ? "Something went wrong." : cleaned).slice(0, MAX_ERROR_LENGTH);
}
