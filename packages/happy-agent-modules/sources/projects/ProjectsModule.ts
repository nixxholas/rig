import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import {
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AgentSystemRef,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { createId } from "@paralleldrive/cuid2";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
    mapAsyncLock,
    type Context,
    type MapAsyncLock,
    type RootContext,
} from "@steve.kite/stdlib";

import { cloneRemoteRepository, remoteUrlForSource } from "../git/cloneRemoteRepository.js";
import { detectGitDefaultBranch } from "../git/detectGitDefaultBranch.js";
import { GitCredentialBroker, type GitAuthentication } from "../git/GitCredentialBroker.js";
import type { GitCommandRunner } from "../git/GitCommandRunner.js";
import { normalizeFuturePath } from "../git/normalizeFuturePath.js";
import { normalizeProjectCwd } from "../git/normalizeProjectCwd.js";
import { probeGitRepository, type GitRepositoryProbe } from "../git/probeGitRepository.js";
import { readGitTopLevel } from "../git/readGitTopLevel.js";
import { remoteProjectName } from "../git/remoteProjectName.js";
import { runGitCommandWithEnvironment, directGitCommandRunner } from "../git/runGitCommand.js";
import { runSandboxedGitCommand } from "../git/runSandboxedGitCommand.js";
import { selectGitRemoteUrl } from "../git/selectGitRemoteUrl.js";
import type { GitRepositoryFacts, ProjectCreator } from "../git/types.js";

import {
    MAX_PROJECT_AVATAR_BYTES,
    MAX_PROJECT_ERROR_LENGTH,
    MAX_PROJECT_INITIALIZATION_ATTEMPTS,
    projectAdoptRemoteNameInputSchema,
    projectAgentIdSchema,
    projectAvatarAssetSchema,
    projectAvatarHashSchema,
    projectClearAvatarInputSchema,
    projectCreateInputSchema,
    projectEnsureInputSchema,
    projectEventIdSchema,
    projectGitFactsInputSchema,
    projectIdSchema,
    projectInitializationFailureInputSchema,
    projectProbeInputSchema,
    projectRenameInputSchema,
    projectReorderInputSchema,
    projectRepositoryRefSchema,
    projectSetAvatarInputSchema,
    projectSetDefaultBranchInputSchema,
    projectTimestampSchema,
    type Project,
    type ProjectAdoptRemoteNameInput,
    type ProjectAvatar,
    type ProjectAvatarAsset,
    type ProjectClearAvatarInput,
    type ProjectCreateInput,
    type ProjectEnsureInput,
    type ProjectGitFacts,
    type ProjectGitFactsInput,
    type ProjectInitializationFailureInput,
    type ProjectProbeInput,
    type ProjectRemoteSource,
    type ProjectRenameInput,
    type ProjectReorderInput,
    type ProjectSetAvatarInput,
    type ProjectSetDefaultBranchInput,
} from "./Project.js";
import {
    projectCloneRemoteSchema,
    projectCreatorOptionSchema,
    projectEnvironmentSchema,
    projectGitCredentialBrokerSchema,
    projectGitRunnerSchema,
    projectHostErrorSchema,
    projectNowSchema,
    projectProfileResolverSchema,
    projectRootContextSchema,
    projectSecretResolverSchema,
    type CreateRemoteProjectRequest,
    type ProjectCreatorOptions,
    type ProjectCreatorProfile,
    type RegisterProjectRequest,
} from "./ProjectProvisioning.js";
import { ProjectRegistrationError } from "./ProjectRegistrationError.js";
import { collectProjectAvatarGarbage } from "./impl/collectProjectAvatarGarbage.js";
import { findHostingAvatar, findRepositoryAvatar } from "./impl/findProjectAvatar.js";
import { getManagedProjectsDirectory } from "./impl/getManagedProjectsDirectory.js";
import { MAX_AVATAR_BYTES, normalizeProjectAvatar } from "./impl/normalizeProjectAvatar.js";
import { ProjectAvatarStore } from "./impl/ProjectAvatarStore.js";
import {
    clientChosenId,
    clientChosenProjectId,
    validateManagedProjectFolderName,
    validateProjectName,
} from "./impl/projectNames.js";
import { validateRegistrationPath } from "./impl/validateRegistrationPath.js";
import { projectGitFactsFrom } from "./projectGitFacts.js";
import { ProjectMutations } from "./ProjectMutations.js";
import {
    fitProjectPage,
    formatPageForModel,
    formatProjectForModel,
    formatSettingsForModel,
} from "./ProjectFormat.js";
import { isPromiseLike, parseCursor, requirePromise } from "./projectRuntime.js";
import {
    projectContextSchema,
    projectEventSchema,
    projectModuleListenerSchema,
    type ProjectModuleListener,
    type ProjectStateChangeReason,
} from "./ProjectEvent.js";
import { projectMigrations } from "./ProjectMigrations.js";
import {
    MAX_PROJECT_PAGE_SIZE,
    projectPageQuerySchema,
    type ProjectPage,
    type ProjectPageQuery,
} from "./ProjectPage.js";
import { assertProject } from "./ProjectRow.js";
import {
    projectSettingsUpdateInputSchema,
    type ProjectSettings,
    type ProjectSettingsUpdateInput,
} from "./ProjectSettings.js";
import {
    assertProjectPage,
    assertProjectStoreMutationResult,
    createProjectStore,
    type ProjectEnsureResult,
    type ProjectStateChanges,
    type ProjectSettingsUpdateResult,
    type ProjectStore,
    type ProjectStoreMutationResult,
} from "./ProjectStore.js";
import {
    assertProjectRecord,
    assertProjectSettings,
    assertProjectTransition,
    sameJson,
} from "./ProjectTransition.js";
import { folderProjectName, HOME_PROJECT_NAME } from "./projectIdentity.js";
import { listProjectsTool } from "./tools/index.js";

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_OUTPUT_CHARACTERS = 12_000;

/** Fields one lifecycle write is allowed to move. */
const PROJECT_STATE_FIELDS = [
    "name",
    "nameSource",
    "presence",
    "worktreeSupport",
    "worktreeUnsupportedReason",
    "defaultBranch",
    "initializationStatus",
    "initializationAttempt",
    "initializationError",
    "gitAhead",
    "gitBehind",
    "gitDetached",
    "gitBranch",
    "gitHead",
    "gitUpstream",
] as const satisfies readonly (keyof Project)[];

export const projectIdFactorySchema = Type.Function(
    [projectContextSchema],
    Type.Union([projectIdSchema, Type.Promise(projectIdSchema)]),
);

export const projectEventIdFactorySchema = Type.Function(
    [projectContextSchema],
    Type.Union([projectEventIdSchema, Type.Promise(projectEventIdSchema)]),
);

export const projectClockSchema = Type.Function(
    [projectContextSchema],
    projectTimestampSchema,
);

export const projectPostCommitErrorSchema = Type.Function(
    [projectContextSchema, projectEventSchema, Type.Unknown()],
    Type.Union([Type.Void(), Type.Promise(Type.Void())]),
);

const projectMaxPageSizeSchema = Type.Integer({
    minimum: 1,
    maximum: MAX_PROJECT_PAGE_SIZE,
});
const projectMaxOutputSchema = Type.Integer({
    minimum: 256,
    maximum: 100_000,
});

export const projectModuleOptionsSchema = Type.Object(
    {
        /**
         * Whether this machine's whole project catalog is visible to the model. Looking beyond the
         * session's own project is off unless the user turned it on, so it defaults to false.
         */
        crossWorkspace: Type.Optional(Type.Boolean()),
        idFactory: Type.Optional(projectIdFactorySchema),
        eventIdFactory: Type.Optional(projectEventIdFactorySchema),
        clock: Type.Optional(projectClockSchema),
        listener: Type.Optional(projectModuleListenerSchema),
        maxPageSize: Type.Optional(projectMaxPageSizeSchema),
        maxOutputCharacters: Type.Optional(projectMaxOutputSchema),
        onPostCommitError: Type.Optional(projectPostCommitErrorSchema),

        /**
         * The lifetime the catalog's own Git and filesystem work runs on: a context derived from
         * the application root, carrying the agent database. Cloning a repository, setting a
         * project up, and collecting stale avatar bytes all outlive the request that started them,
         * so they never run on the caller's context. Without one the catalog still records
         * everything it is told; it simply cannot start work of its own.
         */
        rootContext: Type.Optional(projectRootContextSchema),
        /** Replaces both Git surfaces at once, so a test can drive lifecycle without Git. */
        git: Type.Optional(projectGitRunnerSchema),
        /** The read-only Git surface used for probing folders. Defaults to a sandboxed runner. */
        probeGit: Type.Optional(projectGitRunnerSchema),
        gitCredentialBroker: Type.Optional(projectGitCredentialBrokerSchema),
        cloneRemote: Type.Optional(projectCloneRemoteSchema),
        environment: Type.Optional(projectEnvironmentSchema),
        homeDirectory: Type.Optional(Type.String({ minLength: 1 })),
        managedProjectsDirectory: Type.Optional(Type.String({ minLength: 1 })),
        /** Where avatar bytes live. Beside the agent database, so they survive a restart. */
        stateDirectory: Type.Optional(Type.String({ minLength: 1 })),
        /**
         * The one person this copy of Rig acts for, when a caller names nobody.
         *
         * A catalog told neither which machine it runs on nor which profile it commits as has no
         * local person, and asks the caller to say who is acting.
         */
        localProfileId: Type.Optional(Type.String({ minLength: 1 })),
        resolveGitSecret: Type.Optional(projectSecretResolverSchema),
        resolveProfile: Type.Optional(projectProfileResolverSchema),
        now: Type.Optional(projectNowSchema),
        /** Told when the catalog's own Git or filesystem work failed after a durable decision. */
        onHostError: Type.Optional(projectHostErrorSchema),
    },
    { additionalProperties: false },
);

export type ProjectModuleOptions = Static<typeof projectModuleOptionsSchema>;

const MAX_PROJECT_INITIALIZATION_RETRIES = 3;

export class ProjectsModule implements AgentModule {
    readonly name = "projects";
    readonly migrations = projectMigrations;

    readonly #store: ProjectStore;
    readonly #mutations: ProjectMutations;
    readonly #idFactory: NonNullable<ProjectModuleOptions["idFactory"]>;
    readonly #eventIdFactory: NonNullable<ProjectModuleOptions["eventIdFactory"]>;
    readonly #clock: NonNullable<ProjectModuleOptions["clock"]>;
    readonly #maxPageSize: number;
    readonly #maxOutputCharacters: number;
    readonly #crossWorkspace: boolean;
    #agents: AgentSystemRef | undefined;

    // --- The catalog's own Git and filesystem work -------------------------------------------

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
    readonly #localProfileId: string | undefined;
    readonly #managedProjectsDirectory: string;
    readonly #now: () => number;
    readonly #onHostError: ProjectModuleOptions["onHostError"];
    readonly #pendingInitializations: string[] = [];
    readonly #probeGit: GitCommandRunner;
    readonly #projectLocks: MapAsyncLock<string> = mapAsyncLock();
    readonly #resolveGitSecret: ((kind: "github") => string | undefined) | undefined;
    readonly #resolveProfile: ProjectModuleOptions["resolveProfile"];
    readonly #rootContext: RootContext | undefined;
    readonly #stateDirectory: string;
    readonly #tasks = new Set<Promise<void>>();

    #activeInitializations = 0;
    #closed = false;
    /** This machine, as the installation that built the catalog named it. */
    #localInstanceId: string | undefined;

    constructor(options: ProjectModuleOptions) {
        assertProjectModuleOptions(options);
        this.#store = createProjectStore();
        this.#crossWorkspace = options.crossWorkspace ?? false;
        this.#idFactory = options.idFactory ?? ((_ctx: Context) => globalThis.crypto.randomUUID());
        this.#eventIdFactory =
            options.eventIdFactory ?? ((_ctx: Context) => globalThis.crypto.randomUUID());
        this.#clock = options.clock ?? ((_ctx: Context) => Date.now());
        this.#maxPageSize = options.maxPageSize ?? DEFAULT_PAGE_SIZE;
        this.#maxOutputCharacters = options.maxOutputCharacters ?? DEFAULT_OUTPUT_CHARACTERS;
        this.#mutations = new ProjectMutations({
            store: this.#store,
            eventIdFactory: this.#eventIdFactory,
            clock: this.#clock,
            listener: options.listener,
            onPostCommitError: options.onPostCommitError,
        });

        this.#rootContext = options.rootContext;
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
        this.#localProfileId = options.localProfileId;
        this.#managedProjectsDirectory = normalizeFuturePath(
            options.managedProjectsDirectory ??
                getManagedProjectsDirectory(this.#environment, this.#homeDirectory),
        );
        this.#now = options.now ?? Date.now;
        this.#onHostError = options.onHostError;
        this.#resolveGitSecret = options.resolveGitSecret;
        this.#resolveProfile = options.resolveProfile;
        this.#stateDirectory = normalizeFuturePath(
            options.stateDirectory ?? join(tmpdir(), `rig-projects-${createId()}`),
        );
        this.#avatars = new ProjectAvatarStore(this.#stateDirectory);
    }

    readonly #hooks: AgentModuleHooks = {
        tools: async (ctx: Context, scope: AgentModuleScope): Promise<readonly AnyAgentTool[]> => {
            // The catalog spans every project on the machine, which is exactly what looking
            // outside the current one means, so the user's setting decides whether it exists at
            // all. A subagent works inside the task it was handed and never gets it.
            if (!this.#crossWorkspace) return [];
            const agents = this.#agents;
            if (agents === undefined) {
                throw new Error("The projects module was asked for tools before it started.");
            }
            if ((await agents.parentOf(ctx, scope.agent.id)) !== null) return [];
            return [listProjectsTool(this, scope.agent.id)];
        },
    };

    readonly beforeStart = (_ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        this.#agents = agents;
        return this.#hooks;
    };

    /**
     * Adds another observer of the catalog, alongside whatever the caller configured.
     *
     * Another module that has to react to a project change asks for its own place in the fan-out.
     * The workspaces catalog uses this to archive what was cut from an archived project inside the
     * same transaction, which keeps this catalog free of any knowledge of workspaces.
     */
    addProjectListener(listener: ProjectModuleListener): void {
        this.#mutations.addListener(listener);
    }

    async list(ctx: Context, query: ProjectPageQuery = {}): Promise<ProjectPage> {
        this.#assertInput(projectPageQuerySchema, query, "page query");
        const limit = query.limit ?? this.#maxPageSize;
        if (limit > this.#maxPageSize) {
            throw new Error(`A project page cannot exceed ${String(this.#maxPageSize)} rows.`);
        }
        if (query.cursor !== undefined) parseCursor(query.cursor);
        const normalized = { ...structuredClone(query), limit };
        const raw = await requirePromise(
            this.#store.list(ctx, normalized),
            "Project store list",
        );
        assertProjectPage(raw);
        this.#assertPage(raw, normalized.cursor, limit);
        for (const project of raw.projects) {
            assertProjectRecord(project);
            if (normalized.status !== undefined && project.status !== normalized.status) {
                throw new Error("The project page returned a row outside the requested status.");
            }
            if (
                normalized.status === undefined &&
                normalized.includeArchived !== true &&
                project.status === "archived"
            ) {
                throw new Error(
                    "The project page returned an archived row that was not asked for.",
                );
            }
        }
        return structuredClone(fitProjectPage(raw, normalized.cursor, this.#maxOutputCharacters));
    }

    async get(ctx: Context, projectId: string): Promise<Project | undefined> {
        this.#assertId(projectId);
        const project = await this.#mutations.getOptional(ctx, projectId);
        if (project === undefined) return undefined;
        return structuredClone(project);
    }

    /**
     * Resolves a canonical folder path to its project. This is the catalog's
     * path-keyed identity: a host that knows only a working directory finds the
     * owning project here.
     */
    async getByPath(
        ctx: Context,
        repositoryRef: string,
    ): Promise<Project | undefined> {
        if (!Value.Check(projectRepositoryRefSchema, repositoryRef)) {
            throw new Error("A project folder must be an absolute path.");
        }
        const project = await this.#mutations.findByPath(ctx, repositoryRef);
        if (project === undefined) return undefined;
        return structuredClone(project);
    }

    async readSettings(ctx: Context, projectId: string): Promise<ProjectSettings> {
        this.#assertId(projectId);
        const project = await this.#mutations.getRequired(ctx, projectId);
        return await this.#mutations.readSettings(ctx, projectId);
    }

    async create(ctx: Context, input: ProjectCreateInput): Promise<Project> {
        this.#assertInput(projectCreateInputSchema, input, "creation");
        const normalized = structuredClone(input);
        const projectId = normalized.id ?? (await this.#newIdentity(ctx));
        const kind = normalized.kind ?? "regular";
        const result = await this.#mutations.run(ctx, {
            changeable: [],
            event: (after) => ({ type: "project_created", project: after }),
            run: async (txCtx) => {
                if (
                    (await this.#mutations.findByPath(txCtx, normalized.repositoryRef)) !==
                    undefined
                ) {
                    throw new Error(
                        `The folder "${normalized.repositoryRef}" is already a project. Use ensure_project instead.`,
                    );
                }
                if ((await this.#mutations.getOptional(txCtx, projectId)) !== undefined) {
                    throw new Error(`Project "${projectId}" already exists.`);
                }
                return await requirePromise(
                    this.#store.create(txCtx, {
                        id: projectId,
                        repositoryRef: normalized.repositoryRef,
                        kind,
                        name:
                            kind === "home"
                                ? HOME_PROJECT_NAME
                                : validateProjectName(normalized.name),
                        nameSource: normalized.nameSource ?? "folder",
                        ...(normalized.description === undefined
                            ? {}
                            : { description: normalized.description }),
                        ...(normalized.remoteSource === undefined
                            ? {}
                            : { remoteSource: normalized.remoteSource }),
                        ...(normalized.requiredSecretKind === undefined
                            ? {}
                            : { requiredSecretKind: normalized.requiredSecretKind }),
                    }),
                    "Project store create",
                );
            },
        });
        return requireProjectFromResult(result);
    }

    /**
     * Converges on one project for a folder. A repeated call returns the
     * existing project, and an archived project comes back to the active
     * catalog rather than becoming a second row for the same folder.
     */
    async ensure(
        ctx: Context,
        input: ProjectEnsureInput,
    ): Promise<ProjectEnsureResult> {
        this.#assertInput(projectEnsureInputSchema, input, "ensure");
        const normalized = structuredClone(input);
        const candidateId = await this.#newIdentity(ctx);
        const kind = normalized.kind ?? "regular";
        const result = await this.#mutations.run(ctx, {
            changeable: ["status", "archivedAt"],
            event: (after, before) =>
                before === undefined
                    ? { type: "project_created", project: after }
                    : { type: "project_restored", project: after },
            run: async (txCtx) =>
                await requirePromise(
                    this.#store.ensure(txCtx, {
                        id: candidateId,
                        repositoryRef: normalized.repositoryRef,
                        kind,
                        name:
                            kind === "home"
                                ? HOME_PROJECT_NAME
                                : (normalized.name ?? folderProjectName(normalized.repositoryRef)),
                        nameSource: normalized.nameSource ?? "folder",
                        ...(normalized.description === undefined
                            ? {}
                            : { description: normalized.description }),
                        ...(normalized.remoteSource === undefined
                            ? {}
                            : { remoteSource: normalized.remoteSource }),
                        ...(normalized.requiredSecretKind === undefined
                            ? {}
                            : { requiredSecretKind: normalized.requiredSecretKind }),
                    }),
                    "Project store ensure",
                ),
            beforeByPath: normalized.repositoryRef,
        });
        if (result.operation !== "ensure") {
            throw new Error("Project ensure returned another operation.");
        }
        return structuredClone(result);
    }

    async rename(ctx: Context, input: ProjectRenameInput): Promise<Project> {
        this.#assertInput(projectRenameInputSchema, input, "rename");
        // A display name someone typed is trimmed and bounded here, at the boundary it enters the
        // catalog through. The schema only keeps the column honest; what a person may call a project
        // is a narrower question, and it has to be the same answer whichever door the name came in.
        const normalized = { ...structuredClone(input), name: validateProjectName(input.name) };
        const result = await this.#mutations.run(ctx, {
            changeable: ["name", "nameSource"],
            projectId: normalized.projectId,
            event: (after, before) => ({
                type: "project_renamed",
                project: after,
                previousName: before?.name ?? after.name,
            }),
            run: async (txCtx) =>
                await requirePromise(
                    this.#store.rename(txCtx, {
                        projectId: normalized.projectId,
                        name: normalized.name,
                        ...(normalized.expectedVersion === undefined
                            ? {}
                            : { expectedVersion: normalized.expectedVersion }),
                    }),
                    "Project store rename",
                ),
        });
        return requireProjectFromResult(result);
    }

    async archive(ctx: Context, projectId: string): Promise<Project> {
        this.#assertId(projectId);
        const result = await this.#mutations.run(ctx, {
            changeable: ["status", "archivedAt"],
            projectId,
            event: (after) => ({ type: "project_archived", project: after }),
            run: async (txCtx) =>
                await requirePromise(
                    this.#store.archive(txCtx, { projectId }),
                    "Project store archive",
                ),
        });
        const project = requireProjectFromResult(result);
        if (project.status !== "archived") {
            throw new Error("Project archival did not leave the project archived.");
        }
        // Nobody works in this project any more, so the credential it was cloned with stops being
        // available to anything that still asks.
        this.#gitCredentialBroker.revoke(projectId);
        return project;
    }

    /** Brings an archived project back. Restoring an active project changes nothing. */
    async restore(ctx: Context, projectId: string): Promise<Project> {
        this.#assertId(projectId);
        const result = await this.#mutations.run(ctx, {
            changeable: ["status", "archivedAt"],
            projectId,
            event: (after) => ({ type: "project_restored", project: after }),
            run: async (txCtx) =>
                await requirePromise(
                    this.#store.restore(txCtx, { projectId }),
                    "Project store restore",
                ),
        });
        const project = requireProjectFromResult(result);
        if (project.status !== "active") {
            throw new Error("Project restoration did not leave the project active.");
        }
        return project;
    }

    async reorder(ctx: Context, input: ProjectReorderInput): Promise<Project> {
        this.#assertInput(projectReorderInputSchema, input, "reorder");
        const normalized = structuredClone(input);
        const result = await this.#mutations.run(ctx, {
            changeable: ["orderKey"],
            projectId: normalized.projectId,
            event: (after, before) => ({
                type: "project_reordered",
                previousOrderKey: before?.orderKey ?? after.orderKey,
                project: after,
            }),
            run: async (txCtx) =>
                await requirePromise(
                    this.#store.reorder(txCtx, normalized),
                    "Project store reorder",
                ),
        });
        return requireProjectFromResult(result);
    }

    async setAvatar(ctx: Context, input: ProjectSetAvatarInput): Promise<Project> {
        this.#assertInput(projectSetAvatarInputSchema, input, "avatar");
        const normalized = structuredClone(input);
        const result = await this.#mutations.run(ctx, {
            changeable: ["avatar"],
            projectId: normalized.projectId,
            event: (after) => ({ type: "project_avatar_updated", project: after }),
            run: async (txCtx) =>
                await requirePromise(
                    this.#store.setAvatar(txCtx, normalized),
                    "Project store set avatar",
                ),
        });
        const project = requireProjectFromResult(result);
        if (!sameJson(project.avatar, normalized.avatar)) {
            throw new Error("The stored avatar does not match the one that was requested.");
        }
        return project;
    }

    async clearAvatar(
        ctx: Context,
        input: ProjectClearAvatarInput,
    ): Promise<Project> {
        this.#assertInput(projectClearAvatarInputSchema, input, "avatar clear");
        const normalized = structuredClone(input);
        const result = await this.#mutations.run(ctx, {
            changeable: ["avatar"],
            projectId: normalized.projectId,
            event: (after) => ({ type: "project_avatar_cleared", project: after }),
            run: async (txCtx) =>
                await requirePromise(
                    this.#store.clearAvatar(txCtx, normalized),
                    "Project store clear avatar",
                ),
        });
        const project = requireProjectFromResult(result);
        if (project.avatar !== undefined) {
            throw new Error("The project still has an avatar after it was cleared.");
        }
        // Setting the project up again is what looks for a picture, so clearing one asks for that
        // look rather than leaving the project without an image until something else happens.
        if (project.kind === "regular") {
            await this.scheduleInitialization(ctx, normalized.projectId);
        }
        return project;
    }

    async avatarAsset(
        ctx: Context,
        hash: string,
    ): Promise<ProjectAvatarAsset | undefined> {
        if (!Value.Check(projectAvatarHashSchema, hash)) {
            throw new Error("The project avatar hash is invalid.");
        }
        const project = await this.#store.findByAvatarHash(ctx, hash);
        if (project === undefined) return undefined;
        assertProject(project);
        assertProjectRecord(project);
        const raw = await this.#avatars.read(hash);
        if (raw === undefined) return undefined;
        assertProjectAvatarAsset(raw);
        if (
            raw.hash !== hash ||
            raw.bytes.byteLength > MAX_PROJECT_AVATAR_BYTES ||
            raw.mediaType !== "image/webp"
        ) {
            throw new Error("The stored project avatar does not match the one asked for.");
        }
        return structuredClone(raw);
    }

    async updateSettings(
        ctx: Context,
        input: ProjectSettingsUpdateInput,
    ): Promise<ProjectSettingsUpdateResult> {
        this.#assertInput(projectSettingsUpdateInputSchema, input, "settings update");
        assertProjectSettings(input.settings);
        const normalized = structuredClone(input);
        return await ctx.inTx(async (txCtx) => {
            const before = await this.#mutations.getRequired(txCtx, normalized.projectId);
            const beforeSettings = await this.#mutations.readSettings(
                txCtx,
                normalized.projectId,
            );
            const raw = await requirePromise(
                this.#store.updateSettings(txCtx, normalized),
                "Project store update settings",
            );
            assertProjectStoreMutationResult(raw);
            if (raw.operation !== "update_settings" || raw.projectId !== normalized.projectId) {
                throw new Error("The settings result does not match the requested project.");
            }
            assertProjectSettings(raw.settings);
            const after = await this.#mutations.getRequired(txCtx, normalized.projectId);
            const afterSettings = await this.#mutations.readSettings(
                txCtx,
                normalized.projectId,
            );
            if (!sameJson(afterSettings, normalized.settings)) {
                throw new Error("The stored settings do not match the ones that were requested.");
            }
            if (raw.version !== after.version) {
                throw new Error("The settings result carries a stale project version.");
            }
            assertProjectTransition(before, after, []);
            const changed = !sameJson(beforeSettings, afterSettings);
            if (raw.changed !== changed) {
                throw new Error("The settings result reports the wrong change.");
            }
            if (changed) {
                await this.#mutations.observe(
                    txCtx,
                    await this.#mutations.newEvent(txCtx, {
                        type: "project_settings_updated",
                        projectId: normalized.projectId,
                        settings: afterSettings,
                    }),
                );
            }
            return structuredClone(raw);
        });
    }

    /**
     * Looks at the project folder and records what it found: whether it is still there, whether a
     * workspace can be cut from it, and where its Git state stands.
     */
    async probe(ctx: Context, projectId: string): Promise<Project> {
        const project = await this.#lookAt(ctx, projectId);
        return await this.#applyProjectProbe(
            ctx,
            projectId,
            await probeGitRepository({
                git: this.#probeGit,
                isHome: project.kind === "home",
                path: project.repositoryRef,
            }),
        );
    }

    /**
     * Decides the trunk from the repository itself. Git resolves upward from a folder, so this
     * only asks when the folder is a repository root: a plain directory inside somebody else's
     * repository must not inherit their branch.
     */
    async resolveDefaultBranch(ctx: Context, projectId: string): Promise<Project> {
        const project = await this.#lookAt(ctx, projectId);
        if (project.defaultBranch !== undefined) return project;
        if (!(await this.#isRepositoryRoot(project))) return project;
        const branch = await detectGitDefaultBranch(this.#git, project.repositoryRef);
        if (branch === undefined) return project;
        return await this.setDefaultBranch(ctx, { projectId, branch });
    }

    /**
     * Takes the name the remote repository gives itself. A name a person chose is left alone, and
     * so is a folder that is not a repository root or has no usable remote.
     */
    async resolveRemoteName(ctx: Context, projectId: string): Promise<Project> {
        const project = await this.#lookAt(ctx, projectId);
        if (project.nameSource !== "folder") return project;
        if (!(await this.#isRepositoryRoot(project))) return project;
        const remote = await selectGitRemoteUrl(this.#git, project.repositoryRef);
        const name = remote === undefined ? undefined : remoteProjectName(remote);
        if (name === undefined) return project;
        return await this.adoptRemoteName(ctx, { projectId, name });
    }

    /** Records what a host probe of the project folder observed. */
    async applyProbe(ctx: Context, input: ProjectProbeInput): Promise<Project> {
        this.#assertInput(projectProbeInputSchema, input, "probe");
        const normalized = structuredClone(input);
        return await this.#changeState(ctx, normalized.projectId, "probe", () => ({
            presence: normalized.presence,
            worktreeSupport: normalized.worktreeSupport,
            worktreeUnsupportedReason: normalized.worktreeUnsupportedReason ?? null,
            ...(normalized.git === undefined ? {} : gitChanges(normalized.git)),
        }));
    }

    /** Records the branch, head, upstream and divergence a host read from Git. */
    async applyGitFacts(
        ctx: Context,
        input: ProjectGitFactsInput,
    ): Promise<Project> {
        this.#assertInput(projectGitFactsInputSchema, input, "Git facts");
        const normalized = structuredClone(input);
        return await this.#changeState(ctx, normalized.projectId, "git_facts", () =>
            gitChanges(normalized.git),
        );
    }

    /**
     * Records the trunk this project's workspaces are cut from. It is decided
     * once, so a project that later sits on another branch does not silently
     * start forking from somewhere else.
     */
    async setDefaultBranch(
        ctx: Context,
        input: ProjectSetDefaultBranchInput,
    ): Promise<Project> {
        this.#assertInput(projectSetDefaultBranchInputSchema, input, "default branch");
        const normalized = structuredClone(input);
        return await this.#changeState(
            ctx,
            normalized.projectId,
            "default_branch",
            (project) =>
                project.defaultBranch === undefined
                    ? { defaultBranch: normalized.branch }
                    : undefined,
        );
    }

    /** Replaces a folder-derived name with the remote's. A name a person chose stays. */
    async adoptRemoteName(
        ctx: Context,
        input: ProjectAdoptRemoteNameInput,
    ): Promise<Project> {
        this.#assertInput(projectAdoptRemoteNameInputSchema, input, "remote name");
        const normalized = structuredClone(input);
        return await this.#changeState(
            ctx,
            normalized.projectId,
            "remote_name",
            (project) =>
                project.nameSource === "folder"
                    ? { name: normalized.name, nameSource: "remote" }
                    : undefined,
        );
    }

    /** The clone has landed, so the folder now exists. */
    async markCloneReady(ctx: Context, projectId: string): Promise<Project> {
        return await this.#changeState(ctx, projectId, "clone_ready", (project) =>
            project.initializationStatus === "initializing" ? { presence: "present" } : undefined,
        );
    }

    async markInitializationReady(
        ctx: Context,
        projectId: string,
    ): Promise<Project> {
        return await this.#changeState(ctx, projectId, "initialization_ready", (project) =>
            project.initializationStatus === "initializing"
                ? {
                      initializationStatus: "ready",
                      initializationAttempt: nextAttempt(project),
                      initializationError: null,
                  }
                : undefined,
        );
    }

    async markInitializationFailed(
        ctx: Context,
        input: ProjectInitializationFailureInput,
    ): Promise<Project> {
        this.#assertInput(projectInitializationFailureInputSchema, input, "initialization failure");
        const normalized = structuredClone(input);
        return await this.#changeState(
            ctx,
            normalized.projectId,
            "initialization_failed",
            (project) =>
                project.initializationStatus === "initializing"
                    ? {
                          initializationStatus: "failed",
                          initializationAttempt: nextAttempt(project),
                          initializationError: normalized.error,
                      }
                    : undefined,
        );
    }

    /** Puts a failed project back in line for another initialization attempt. */
    async retryInitialization(ctx: Context, projectId: string): Promise<Project> {
        return await this.#changeState(
            ctx,
            projectId,
            "initialization_retried",
            (project) =>
                project.initializationStatus === "failed"
                    ? { initializationStatus: "initializing", initializationError: null }
                    : undefined,
        );
    }

    /**
     * Puts a project back in line for setup. Nothing initializes the home project, so for `home`
     * this is a no-op that returns the row untouched, like every other guarded lifecycle write.
     */
    async refresh(ctx: Context, projectId: string): Promise<Project> {
        return await this.#changeState(ctx, projectId, "refresh", (project) =>
            project.kind === "home"
                ? undefined
                : {
                      initializationStatus: "initializing",
                      initializationAttempt: nextAttempt(project),
                      initializationError: null,
                  },
        );
    }

    /**
     * Asks for a project to be set up again, whatever state it reached, and starts that setup.
     *
     * This is the whole operation a person asks for, so unlike `refresh` it refuses the home project
     * outright rather than quietly doing nothing: somebody who pressed a button deserves to be told
     * there was nothing to press it for.
     */
    async setUpAgain(ctx: Context, projectId: string): Promise<Project> {
        if ((await this.#lookAt(ctx, projectId)).kind === "home") {
            throw new Error("The Home project does not need to be set up.");
        }
        const refreshed = await this.refresh(ctx, projectId);
        await this.scheduleInitialization(ctx, projectId);
        return refreshed;
    }

    // --- Folders, Git, and setup -------------------------------------------------------------
    //
    // Everything below is the work the records describe: canonical paths, managed folders, clones,
    // credentials, probes, avatar bytes, and the background setup that carries a new project
    // through to a usable one. The catalog does it itself; nothing is handed to a host.

    /** Where projects Rig created for someone live. */
    get managedProjectsDirectory(): string {
        return this.#managedProjectsDirectory;
    }

    /** The folder that is this machine's Home project. */
    get homeDirectory(): string {
        return this.#homeDirectory;
    }

    /** The Git surface for foreground work in a project folder. */
    get git(): GitCommandRunner {
        return this.#git;
    }

    /** The read-only Git surface used to look at a folder without changing it. */
    get probeGit(): GitCommandRunner {
        return this.#probeGit;
    }

    /** Who a project belongs to when the caller named nobody: this machine, and its one person. */
    get #localCreator(): ProjectCreator | undefined {
        const instanceId = this.#localInstanceId;
        const profileId = this.#localProfileId;
        if (instanceId === undefined || profileId === undefined) return undefined;
        return { instanceId, profileId };
    }

    /**
     * Picks up whatever the last run left unfinished: projects still being set up, failures worth
     * another try, and stale avatar bytes.
     */
    async open(ctx: Context, localInstanceId: string): Promise<void> {
        this.#localInstanceId = localInstanceId;
        for (const project of await this.#allProjects(ctx)) {
            if (project.kind !== "regular" || project.status === "archived") continue;
            if (project.initializationStatus === "initializing") {
                await this.scheduleInitialization(ctx, project.id);
            } else if (
                project.initializationStatus === "failed" &&
                project.initializationAttempt < MAX_PROJECT_INITIALIZATION_RETRIES &&
                existsSync(project.repositoryRef)
            ) {
                await this.retryInitialization(ctx, project.id);
                await this.scheduleInitialization(ctx, project.id);
            }
        }
        this.#runInBackground("project-avatar-maintenance", async (workerCtx) => {
            await this.collectAvatarGarbage(workerCtx);
        });
    }

    /** Stops every background lifetime the catalog started and waits for the ones in flight. */
    async close(_ctx: Context): Promise<void> {
        this.#closed = true;
        this.#backgroundAbort.abort();
        this.#gitCredentialBroker.close();
        this.#pendingInitializations.length = 0;
        while (this.#tasks.size > 0) {
            await Promise.allSettled([...this.#tasks]);
        }
    }

    /**
     * Runs work while this project's Git lock is held.
     *
     * Every worktree of a project shares one set of refs and reflogs, so the catalog that owns the
     * project owns that lock, and the workspaces catalog takes it through here rather than keeping
     * a second lock over the same repository.
     */
    async runInProjectGitLock<T>(
        ctx: Context,
        projectId: string,
        work: (lockedCtx: Context) => Promise<T>,
    ): Promise<T> {
        return await this.#projectLocks.runInLock(ctx, projectId, work);
    }

    /**
     * Finds the project a folder belongs to, importing the folder as a project if it is new.
     *
     * `requestedProjectId` names that import. A project is a folder, so a folder Rig already knows
     * keeps the identity it has and the request is simply answered with it; the requested identity
     * only takes effect for a folder that becomes a project now.
     */
    async resolvePath(
        ctx: Context,
        cwd: string,
        requestedProjectId?: string,
    ): Promise<Project> {
        const path = normalizeProjectCwd(cwd);
        const importedId =
            requestedProjectId === undefined
                ? undefined
                : clientChosenId(requestedProjectId, "project");
        const existing = await this.getByPath(ctx, path);
        if (existing !== undefined) {
            // A project is only a folder, so working in it again is what brings it back: starting
            // a session restores an archived project instead of asking someone to unarchive it.
            if (importedId !== undefined && importedId !== existing.id) {
                await this.#assertUnusedProjectId(ctx, importedId, path);
            }
            return existing.status === "archived"
                ? await this.restore(ctx, existing.id)
                : existing;
        }
        if (importedId !== undefined) {
            await this.#assertUnusedProjectId(ctx, importedId, path);
        }

        const kind = path === this.#homeDirectory ? "home" : "regular";
        const project = await this.create(ctx, {
            ...(importedId === undefined ? {} : { id: importedId }),
            repositoryRef: path,
            kind,
            name: kind === "home" ? HOME_PROJECT_NAME : folderProjectName(path),
        });
        if (kind === "regular") await this.scheduleInitialization(ctx, project.id);
        return project;
    }

    /**
     * Adds one explicit Git project without starting a session. Validation happens before the
     * shared folder import, so a registered project is always the canonical root of a working tree.
     */
    async register(
        ctx: Context,
        request: RegisterProjectRequest,
    ): Promise<Project> {
        if (!isAbsolute(request.path)) {
            throw new ProjectRegistrationError(
                "invalid_request",
                "The project path must be absolute.",
            );
        }
        if (request.projectId !== undefined) clientChosenProjectId(request.projectId);
        const path = await validateRegistrationPath(this.#git, request.path);
        return await this.resolvePath(
            ctx,
            path,
            ...(request.projectId === undefined ? [] : [request.projectId]),
        );
    }

    /** Refuses a client-chosen project identity that already names another folder. */
    async #assertUnusedProjectId(
        ctx: Context,
        id: string,
        path: string,
    ): Promise<void> {
        const known = await this.get(ctx, id);
        if (known !== undefined && known.repositoryRef !== path) {
            throw new ProjectRegistrationError(
                "project_id_conflict",
                "That project ID already names another folder.",
            );
        }
    }

    /** Every project this agent can see, archived ones included. */
    async #allProjects(ctx: Context): Promise<readonly Project[]> {
        return (await this.list(ctx, { includeArchived: true })).projects;
    }

    // --- Setting a project up ----------------------------------------------------------------

    /** Queues the project's setup, if it is not already queued or running. */
    async scheduleInitialization(ctx: Context, projectId: string): Promise<void> {
        if (this.#closed || this.#initializing.has(projectId)) return;
        // A catalog built without a root has nowhere to run setup. That is a supported way to use it
        // — it still records everything it is told — so this declines rather than failing the write
        // that asked, and says so once instead of throwing out of a timer nobody is holding.
        if (this.#rootContext === undefined) {
            ctx.log.debug("Project setup was not started: this catalog has no root lifetime.", {
                projectId,
            });
            return;
        }
        const project = await this.get(ctx, projectId);
        if (project === undefined) return;
        if (!existsSync(project.repositoryRef) && project.remoteSource === undefined) {
            await this.#failInitialization(
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
            const pending = this.#pendingInitializations.shift();
            if (pending === undefined) return;
            this.#activeInitializations += 1;
            this.#runInBackground("project-initialization", async (workerCtx) => {
                try {
                    await this.#initializeProject(workerCtx, pending);
                } finally {
                    this.#activeInitializations -= 1;
                    this.#initializing.delete(pending);
                    if (!this.#closed) this.#drainInitializations();
                }
            });
        }
    }

    async #initializeProject(ctx: Context, projectId: string): Promise<void> {
        if (this.#closed) return;
        const project = await this.get(ctx, projectId);
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
            await this.probe(ctx, projectId);
            if (this.#closed) return;

            let remote: string | undefined;
            const repositoryTopLevel = await this.#isRepositoryRoot(project);
            if (repositoryTopLevel) {
                try {
                    remote = await selectGitRemoteUrl(this.#git, project.repositoryRef);
                } catch {
                    // A repository without a usable remote is a perfectly good project.
                }
            }
            if (this.#closed) return;

            // The trunk is decided while the project is being added, so every later workspace has
            // a branch to fork without re-deciding it under someone's request.
            if (repositoryTopLevel) await this.resolveDefaultBranch(ctx, projectId);
            if (this.#closed) return;

            const detectedName = remote === undefined ? undefined : remoteProjectName(remote);
            const current = await this.get(ctx, projectId);
            if (current === undefined) return;
            if (detectedName !== undefined && current.nameSource === "folder") {
                await this.adoptRemoteName(ctx, { projectId, name: detectedName });
            }

            if ((await this.get(ctx, projectId))?.avatar === undefined) {
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
                    (await this.get(ctx, projectId))?.avatar === undefined
                ) {
                    await this.storeAvatarImage(
                        ctx,
                        projectId,
                        repositoryAvatar === undefined ? "hosting" : "repository",
                        candidate,
                    );
                }
            }
            if (this.#closed) return;

            await this.markInitializationReady(ctx, projectId);
        } catch (error) {
            if (this.#closed) return;
            await this.#failInitialization(ctx, projectId, errorToMessage(error));
        }
    }

    async #failInitialization(
        ctx: Context,
        projectId: string,
        message: string,
    ): Promise<void> {
        await this.markInitializationFailed(ctx, {
            projectId,
            error: boundedReason(message),
        });
    }

    // --- Remote projects and credentials -----------------------------------------------------

    /** Adds a project whose folder Rig has still to clone from a remote repository. */
    async createRemote(
        ctx: Context,
        request: CreateRemoteProjectRequest,
        options: ProjectCreatorOptions = {},
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
                await this.retryInitialization(ctx, id);
            }
            if (retried.initializationStatus !== "ready" && canRetry) {
                await this.scheduleInitialization(ctx, id);
            }
            return (await this.get(ctx, id)) ?? retried;
        }
        if ((await this.getByPath(ctx, path)) !== undefined) {
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
            const project = await this.create(ctx, {
                id,
                repositoryRef: path,
                kind: "regular",
                name,
                remoteSource: request.source,
                ...(request.secret === undefined
                    ? {}
                    : { requiredSecretKind: request.secret.kind }),
            });
            await this.scheduleInitialization(ctx, id);
            return project;
        } catch (error) {
            const raced = await this.#retriedRemoteProject(
                ctx,
                id,
                path,
                request,
                creator,
            );
            if (raced !== undefined) {
                if (raced.initializationStatus !== "ready") {
                    await this.scheduleInitialization(ctx, id);
                }
                return raced;
            }
            this.#gitCredentialBroker.revoke(id);
            this.#creators.delete(id);
            if ((await this.getByPath(ctx, path)) !== undefined) {
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
        const project = await this.get(ctx, id);
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
            await this.markCloneReady(ctx, project.id);
            return;
        }
        const creator = this.#creators.get(project.id) ?? this.#localCreator;
        if (creator === undefined) {
            throw new Error(
                "This project has no known creator, so its repository cannot be cloned. Add it again from the machine that created it.",
            );
        }
        const profile = await this.#resolveProfile?.(creator.profileId, creator.instanceId);
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
            await this.markCloneReady(ctx, project.id);
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
        const project = await this.get(ctx, projectId);
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
        const project = await this.get(ctx, projectId);
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
            await this.retryInitialization(ctx, projectId);
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
        for (const project of await this.#allProjects(ctx)) {
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
                await this.retryInitialization(ctx, project.id);
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

    /**
     * The Git surface for one project, carrying that project's credential when it has one.
     *
     * A workspace cut from a private repository needs the same credential the clone used, so the
     * catalog that holds the credential is the one that hands out the runner.
     */
    gitForProject(projectId: string): GitCommandRunner {
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

    // --- Avatar bytes ------------------------------------------------------------------------

    /** Stores an image for a project and records the metadata that points at it. */
    async storeAvatarImage(
        ctx: Context,
        projectId: string,
        source: ProjectAvatar["source"],
        bytes: Buffer,
        expectedVersion?: number,
    ): Promise<Project | undefined> {
        const project = await this.get(ctx, projectId);
        if (project === undefined) return undefined;
        if (bytes.byteLength > MAX_AVATAR_BYTES) {
            throw new Error("The project image is larger than the allowed limit.");
        }
        const normalized = await normalizeProjectAvatar(bytes);
        return await this.#avatarLocks.runInLock(ctx, normalized.hash, async () => {
            await this.#avatars.write(normalized.hash, normalized.bytes);
            if (this.#closed) return project;
            try {
                return await this.setAvatar(ctx, {
                    projectId,
                    avatar: {
                        hash: normalized.hash,
                        height: normalized.height,
                        mediaType: "image/webp",
                        source,
                        // Where a client should ask for the picture, relative to the daemon API it
                        // already speaks. Clients re-serve this path from their own origin, so it
                        // names the asset route and carries no protocol prefix of its own.
                        url: `/project-assets/${normalized.hash}`,
                        width: normalized.width,
                    },
                    ...(expectedVersion === undefined ? {} : { expectedVersion }),
                });
            } catch (error) {
                await this.#avatars.remove(normalized.hash);
                throw error;
            }
        });
    }

    /** Removes stored avatar bytes no project has pointed at for a day. */
    async collectAvatarGarbage(ctx: Context): Promise<void> {
        if (this.#closed) return;
        const referenced = new Set(
            (await this.#allProjects(ctx))
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

    // --- Git facts ---------------------------------------------------------------------------

    /** Re-derives presence, worktree capability, and Git facts for every live project. */
    async reconcileGitFacts(ctx: Context): Promise<void> {
        for (const project of await this.#allProjects(ctx)) {
            if (this.#closed) return;
            // An archived project is hidden, so re-deriving its Git facts is wasted work.
            if (project.status === "archived") continue;
            await this.probe(ctx, project.id);
        }
    }

    /**
     * Persists Git facts observed by a live scan. Branch, HEAD and upstream are durable state, so
     * a commit or a checkout has to reach clients that are not watching the live stream.
     */
    async recordGitFacts(
        ctx: Context,
        projectId: string,
        facts: GitRepositoryFacts,
    ): Promise<void> {
        await this.applyGitFacts(ctx, {
            projectId,
            git: projectGitFactsFrom(facts),
        });
    }

    async #applyProjectProbe(
        ctx: Context,
        projectId: string,
        probe: GitRepositoryProbe,
    ): Promise<Project> {
        return await this.applyProbe(ctx, {
            projectId,
            presence: probe.presence,
            worktreeSupport: probe.worktreeSupport,
            ...(probe.worktreeSupportReason === undefined
                ? {}
                : { worktreeUnsupportedReason: boundedReason(probe.worktreeSupportReason) }),
            ...(probe.facts === undefined ? {} : { git: projectGitFactsFrom(probe.facts) }),
        });
    }

    /**
     * Starts work that outlives whatever asked for it, on its own named lifetime. The caller's
     * context is deliberately not used: a clone must not end when a request does.
     */
    #runInBackground(name: string, work: (ctx: Context) => Promise<void>): void {
        if (this.#closed) return;
        const root = this.#rootContext;
        if (root === undefined) {
            throw new Error(
                "This project catalog was built without a rootContext, so it cannot start background work.",
            );
        }
        const task = work(root.named(name))
            .catch(() => undefined)
            .finally(() => {
                this.#tasks.delete(task);
            });
        this.#tasks.add(task);
    }

    formatProjectForModel(label: string, project: Project): string {
        assertProject(project);
        return formatProjectForModel(label, project, this.#maxOutputCharacters);
    }

    formatPageForModel(page: ProjectPage): string {
        assertProjectPage(page);
        return formatPageForModel(page, this.#maxOutputCharacters);
    }

    formatSettingsForModel(projectId: string, settings: ProjectSettings): string {
        assertProjectSettings(settings);
        return formatSettingsForModel(projectId, settings, this.#maxOutputCharacters);
    }

    /** The project this operation names, or a refusal saying it is not in the catalog. */
    async #lookAt(ctx: Context, projectId: string): Promise<Project> {
        this.#assertId(projectId);
        return await this.#mutations.getRequired(ctx, projectId);
    }

    /**
     * Whether Git considers this exact folder a repository root, rather than somewhere inside one.
     */
    async #isRepositoryRoot(project: Project): Promise<boolean> {
        if (project.kind === "home") return false;
        try {
            return (
                (await readGitTopLevel(this.#git, project.repositoryRef)) === project.repositoryRef
            );
        } catch {
            // A regular folder without Git is a perfectly good project.
            return false;
        }
    }

    async #changeState(
        ctx: Context,
        projectId: string,
        reason: ProjectStateChangeReason,
        compute: (project: Project) => ProjectStateChanges | undefined,
    ): Promise<Project> {
        this.#assertId(projectId);
        const result = await this.#mutations.run(ctx, {
            changeable: PROJECT_STATE_FIELDS,
            projectId,
            event: (after) => ({
                type: "project_state_changed",
                reason,
                project: after,
            }),
            run: async (txCtx, before) => {
                if (before === undefined) throw new Error(`Project "${projectId}" was not found.`);
                // Archiving is the terminal decision about a project. A clone, a probe, a setup
                // result, or a refresh that was already running when it was made describes a
                // project nobody has any more, and changes nothing about it. Restoring is how a
                // project comes back, and it does not go through here.
                const changes = before.status === "archived" ? undefined : compute(before);
                if (changes === undefined) {
                    return {
                        operation: "state_change" as const,
                        changed: false,
                        project: before,
                    };
                }
                return await requirePromise(
                    this.#store.applyState(txCtx, { projectId, changes }),
                    "Project store state change",
                );
            },
        });
        return requireProjectFromResult(result);
    }

    /** A fresh project identity, from the configured factory or this module's own. */
    async #newIdentity(ctx: Context): Promise<string> {
        const raw = this.#idFactory(ctx);
        const value = isPromiseLike(raw) ? await raw : raw;
        if (!Value.Check(projectIdSchema, value)) {
            throw new Error("The project identity factory returned an invalid identity.");
        }
        return value;
    }

    #assertId(projectId: string): void {
        if (!Value.Check(projectIdSchema, projectId)) {
            throw new Error("The project ID is invalid.");
        }
    }

    #assertInput<T>(schema: TSchema, value: unknown, label: string): asserts value is T {
        if (!Value.Check(schema, value)) {
            throw new Error(`The project ${label} input is invalid.`);
        }
    }

    #assertPage(page: ProjectPage, cursor: string | undefined, limit: number): void {
        if (page.projects.length > limit) {
            throw new Error("The project store returned more records than requested.");
        }
        for (let index = 1; index < page.projects.length; index += 1) {
            const previous = page.projects[index - 1]!;
            const current = page.projects[index]!;
            if (
                current.orderKey < previous.orderKey ||
                (current.orderKey === previous.orderKey && current.id <= previous.id)
            ) {
                throw new Error("Project page rows must be unique and in catalog order.");
            }
        }
        if (page.nextCursor === undefined) return;
        if (page.projects.length === 0) {
            throw new Error("An empty project page cannot advance its cursor.");
        }
        const start = cursor === undefined ? 0 : parseCursor(cursor);
        const next = parseCursor(page.nextCursor);
        if (next !== start + page.projects.length) {
            throw new Error("A project page cursor must advance by exactly the visible rows.");
        }
    }
}

export function assertProjectModuleOptions(value: unknown): asserts value is ProjectModuleOptions {
    if (!Value.Check(projectModuleOptionsSchema, value)) {
        throw new Error("The project module options are invalid.");
    }
}

export function assertProjectAvatarAsset(value: unknown): asserts value is ProjectAvatarAsset {
    if (!Value.Check(projectAvatarAssetSchema, value)) {
        throw new Error("The project avatar asset is invalid.");
    }
}

/** Fits an observed reason into the one bounded sentence a project row keeps. */
function boundedReason(reason: string): string {
    const text = reason.trim().replace(/\s+/gu, " ");
    if (text.length === 0) return "No reason was recorded.";
    return text.length <= MAX_PROJECT_ERROR_LENGTH
        ? text
        : `${text.slice(0, MAX_PROJECT_ERROR_LENGTH - 1)}…`;
}

function gitChanges(git: ProjectGitFacts): ProjectStateChanges {
    return {
        gitAhead: git.ahead,
        gitBehind: git.behind,
        gitBranch: git.branch ?? null,
        gitDetached: git.detached,
        gitHead: git.head ?? null,
        gitUpstream: git.upstream ?? null,
    };
}

function nextAttempt(project: Project): number {
    return Math.min(project.initializationAttempt + 1, MAX_PROJECT_INITIALIZATION_ATTEMPTS);
}

function requireProjectFromResult(result: ProjectStoreMutationResult): Project {
    if (!("project" in result)) {
        throw new Error("A project mutation did not return a project.");
    }
    assertProject(result.project);
    return structuredClone(result.project);
}

function errorToMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return typeof error === "string" ? error : JSON.stringify(error);
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
