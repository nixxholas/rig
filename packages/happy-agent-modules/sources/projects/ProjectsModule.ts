import {
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { computePermissions } from "@slopus/happy-agent-compute";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { type Context } from "@steve.kite/stdlib";

import type { HostCompute } from "../compute/ComputeModule.js";

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
    type ProjectRenameInput,
    type ProjectReorderInput,
    type ProjectSetAvatarInput,
    type ProjectSetDefaultBranchInput,
} from "./Project.js";
import {
    projectComputeResolverSchema,
    requireProjectCompute,
    type ProjectComputeResolver,
} from "./ProjectCompute.js";
import { detectProjectDefaultBranch } from "./impl/detectProjectDefaultBranch.js";
import { probeProjectRepository } from "./impl/probeProjectRepository.js";
import { remoteProjectName } from "./impl/remoteProjectName.js";
import { readProjectGit } from "./impl/runProjectGit.js";
import { selectProjectRemoteUrl } from "./impl/selectProjectRemoteUrl.js";
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
    projectAuthorizationSchema,
    type ProjectAuthorizationAction,
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
import {
    archiveProjectTool,
    clearProjectAvatarTool,
    createProjectTool,
    ensureProjectTool,
    getProjectSettingsTool,
    getProjectTool,
    listProjectsTool,
    reorderProjectTool,
    renameProjectTool,
    restoreProjectTool,
    setProjectAvatarTool,
    updateProjectSettingsTool,
} from "./tools/index.js";

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
    [projectContextSchema, projectAgentIdSchema],
    Type.Union([projectIdSchema, Type.Promise(projectIdSchema)]),
);

export const projectEventIdFactorySchema = Type.Function(
    [projectContextSchema, projectAgentIdSchema],
    Type.Union([projectEventIdSchema, Type.Promise(projectEventIdSchema)]),
);

export const projectClockSchema = Type.Function(
    [projectContextSchema, projectAgentIdSchema],
    projectTimestampSchema,
);

export const projectPostCommitErrorSchema = Type.Function(
    [projectContextSchema, projectEventSchema, Type.Unknown()],
    Type.Union([Type.Void(), Type.Promise(Type.Void())]),
);

/**
 * Optional host bridge for the bytes behind a catalog avatar. The catalog
 * remains useful without it: project metadata is durable, while asset reads
 * return undefined until a host supplies this bridge.
 */
export const projectAvatarAssetReaderSchema = Type.Object(
    {
        read: Type.Function(
            [projectContextSchema, projectAgentIdSchema, projectAvatarHashSchema],
            Type.Promise(Type.Union([projectAvatarAssetSchema, Type.Undefined()])),
        ),
    },
    { additionalProperties: false },
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
        authorization: Type.Optional(projectAuthorizationSchema),
        avatarAssetReader: Type.Optional(projectAvatarAssetReaderSchema),
        compute: Type.Optional(projectComputeResolverSchema),
        idFactory: Type.Optional(projectIdFactorySchema),
        eventIdFactory: Type.Optional(projectEventIdFactorySchema),
        clock: Type.Optional(projectClockSchema),
        listener: Type.Optional(projectModuleListenerSchema),
        maxPageSize: Type.Optional(projectMaxPageSizeSchema),
        maxOutputCharacters: Type.Optional(projectMaxOutputSchema),
        onPostCommitError: Type.Optional(projectPostCommitErrorSchema),
    },
    { additionalProperties: false },
);

export type ProjectModuleOptions = Static<typeof projectModuleOptionsSchema>;
export type ProjectAvatarAssetReader = Static<typeof projectAvatarAssetReaderSchema>;

export class ProjectsModule implements AgentModule {
    readonly name = "projects";
    readonly migrations = projectMigrations;

    readonly #store: ProjectStore;
    readonly #mutations: ProjectMutations;
    readonly #compute: ProjectComputeResolver | undefined;
    readonly #avatarAssetReader: ProjectModuleOptions["avatarAssetReader"];
    readonly #idFactory: NonNullable<ProjectModuleOptions["idFactory"]>;
    readonly #eventIdFactory: NonNullable<ProjectModuleOptions["eventIdFactory"]>;
    readonly #clock: NonNullable<ProjectModuleOptions["clock"]>;
    readonly #maxPageSize: number;
    readonly #maxOutputCharacters: number;

    constructor(options: ProjectModuleOptions) {
        assertProjectModuleOptions(options);
        this.#store = createProjectStore();
        this.#compute = options.compute;
        this.#avatarAssetReader = options.avatarAssetReader;
        this.#idFactory =
            options.idFactory ??
            ((_ctx: Context, _agentId: string) => globalThis.crypto.randomUUID());
        this.#eventIdFactory =
            options.eventIdFactory ??
            ((_ctx: Context, _agentId: string) => globalThis.crypto.randomUUID());
        this.#clock = options.clock ?? ((_ctx: Context, _agentId: string) => Date.now());
        this.#maxPageSize = options.maxPageSize ?? DEFAULT_PAGE_SIZE;
        this.#maxOutputCharacters = options.maxOutputCharacters ?? DEFAULT_OUTPUT_CHARACTERS;
        this.#mutations = new ProjectMutations({
            store: this.#store,
            authorization: options.authorization,
            eventIdFactory: this.#eventIdFactory,
            clock: this.#clock,
            listener: options.listener,
            onPostCommitError: options.onPostCommitError,
        });
    }

    readonly #hooks: AgentModuleHooks = {
        tools: (_ctx: Context, scope: AgentModuleScope): readonly AnyAgentTool[] => {
            this.#assertAgentId(scope.agent.id);
            return [
                listProjectsTool(this, scope.agent.id),
                getProjectTool(this, scope.agent.id),
                createProjectTool(this, scope.agent.id),
                ensureProjectTool(this, scope.agent.id),
                renameProjectTool(this, scope.agent.id),
                archiveProjectTool(this, scope.agent.id),
                restoreProjectTool(this, scope.agent.id),
                reorderProjectTool(this, scope.agent.id),
                setProjectAvatarTool(this, scope.agent.id),
                clearProjectAvatarTool(this, scope.agent.id),
                getProjectSettingsTool(this, scope.agent.id),
                updateProjectSettingsTool(this, scope.agent.id),
            ];
        },
    };

    readonly beforeStart = (): AgentModuleHooks => this.#hooks;

    async list(ctx: Context, agentId: string, query: ProjectPageQuery = {}): Promise<ProjectPage> {
        this.#assertAgentId(agentId);
        this.#assertInput(projectPageQuerySchema, query, "page query");
        const limit = query.limit ?? this.#maxPageSize;
        if (limit > this.#maxPageSize) {
            throw new Error(`A project page cannot exceed ${String(this.#maxPageSize)} rows.`);
        }
        if (query.cursor !== undefined) parseCursor(query.cursor);
        const normalized = { ...structuredClone(query), limit };
        const raw = await requirePromise(
            this.#store.list(ctx, agentId, normalized),
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
                throw new Error("The project page returned an archived row that was not asked for.");
            }
            await this.#mutations.authorize(ctx, agentId, project.ownerAgentId, "list");
        }
        return structuredClone(fitProjectPage(raw, normalized.cursor, this.#maxOutputCharacters));
    }

    async get(ctx: Context, agentId: string, projectId: string): Promise<Project | undefined> {
        this.#assertAgentId(agentId);
        this.#assertId(projectId);
        const project = await this.#mutations.getOptional(ctx, agentId, projectId);
        if (project === undefined) return undefined;
        await this.#mutations.authorize(ctx, agentId, project.ownerAgentId, "get");
        return structuredClone(project);
    }

    /**
     * Resolves a canonical folder path to its project. This is the catalog's
     * path-keyed identity: a host that knows only a working directory finds the
     * owning project here.
     */
    async getByPath(
        ctx: Context,
        agentId: string,
        repositoryRef: string,
    ): Promise<Project | undefined> {
        this.#assertAgentId(agentId);
        if (!Value.Check(projectRepositoryRefSchema, repositoryRef)) {
            throw new Error("A project folder must be an absolute path.");
        }
        const project = await this.#mutations.findByPath(ctx, agentId, repositoryRef);
        if (project === undefined) return undefined;
        await this.#mutations.authorize(ctx, agentId, project.ownerAgentId, "get");
        return structuredClone(project);
    }

    async readSettings(ctx: Context, agentId: string, projectId: string): Promise<ProjectSettings> {
        this.#assertAgentId(agentId);
        this.#assertId(projectId);
        const project = await this.#mutations.getRequired(ctx, agentId, projectId);
        await this.#mutations.authorize(ctx, agentId, project.ownerAgentId, "settings_read");
        return await this.#mutations.readSettings(ctx, agentId, projectId);
    }

    async create(ctx: Context, agentId: string, input: ProjectCreateInput): Promise<Project> {
        this.#assertAgentId(agentId);
        this.#assertInput(projectCreateInputSchema, input, "creation");
        const normalized = structuredClone(input);
        const projectId = normalized.id ?? (await this.#newIdentity(ctx, agentId));
        const kind = normalized.kind ?? "regular";
        const result = await this.#mutations.run(ctx, agentId, {
            action: "create",
            changeable: [],
            event: (after) => ({ type: "project_created", agentId, project: after }),
            run: async (txCtx) => {
                if ((await this.#mutations.findByPath(txCtx, agentId, normalized.repositoryRef)) !== undefined) {
                    throw new Error(
                        `The folder "${normalized.repositoryRef}" is already a project. Use ensure_project instead.`,
                    );
                }
                if ((await this.#mutations.getOptional(txCtx, agentId, projectId)) !== undefined) {
                    throw new Error(`Project "${projectId}" already exists.`);
                }
                return await requirePromise(
                    this.#store.create(txCtx, agentId, {
                        id: projectId,
                        ownerAgentId: agentId,
                        repositoryRef: normalized.repositoryRef,
                        kind,
                        name: kind === "home" ? HOME_PROJECT_NAME : normalized.name,
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
        agentId: string,
        input: ProjectEnsureInput,
    ): Promise<ProjectEnsureResult> {
        this.#assertAgentId(agentId);
        this.#assertInput(projectEnsureInputSchema, input, "ensure");
        const normalized = structuredClone(input);
        const candidateId = await this.#newIdentity(ctx, agentId);
        const kind = normalized.kind ?? "regular";
        const result = await this.#mutations.run(ctx, agentId, {
            action: "ensure",
            changeable: ["status", "archivedAt"],
            event: (after, before) =>
                before === undefined
                    ? { type: "project_created", agentId, project: after }
                    : { type: "project_restored", agentId, project: after },
            run: async (txCtx) =>
                await requirePromise(
                    this.#store.ensure(txCtx, agentId, {
                        id: candidateId,
                        ownerAgentId: agentId,
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

    async rename(ctx: Context, agentId: string, input: ProjectRenameInput): Promise<Project> {
        this.#assertAgentId(agentId);
        this.#assertInput(projectRenameInputSchema, input, "rename");
        const normalized = structuredClone(input);
        const result = await this.#mutations.run(ctx, agentId, {
            action: "rename",
            changeable: ["name", "nameSource"],
            projectId: normalized.projectId,
            event: (after, before) => ({
                type: "project_renamed",
                agentId,
                project: after,
                previousName: before?.name ?? after.name,
            }),
            run: async (txCtx) =>
                await requirePromise(
                    this.#store.rename(txCtx, agentId, {
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

    async archive(ctx: Context, agentId: string, projectId: string): Promise<Project> {
        this.#assertAgentId(agentId);
        this.#assertId(projectId);
        const result = await this.#mutations.run(ctx, agentId, {
            action: "archive",
            changeable: ["status", "archivedAt"],
            projectId,
            event: (after) => ({ type: "project_archived", agentId, project: after }),
            run: async (txCtx) =>
                await requirePromise(
                    this.#store.archive(txCtx, agentId, { projectId }),
                    "Project store archive",
                ),
        });
        const project = requireProjectFromResult(result);
        if (project.status !== "archived") {
            throw new Error("Project archival did not leave the project archived.");
        }
        return project;
    }

    /** Brings an archived project back. Restoring an active project changes nothing. */
    async restore(ctx: Context, agentId: string, projectId: string): Promise<Project> {
        this.#assertAgentId(agentId);
        this.#assertId(projectId);
        const result = await this.#mutations.run(ctx, agentId, {
            action: "restore",
            changeable: ["status", "archivedAt"],
            projectId,
            event: (after) => ({ type: "project_restored", agentId, project: after }),
            run: async (txCtx) =>
                await requirePromise(
                    this.#store.restore(txCtx, agentId, { projectId }),
                    "Project store restore",
                ),
        });
        const project = requireProjectFromResult(result);
        if (project.status !== "active") {
            throw new Error("Project restoration did not leave the project active.");
        }
        return project;
    }

    async reorder(ctx: Context, agentId: string, input: ProjectReorderInput): Promise<Project> {
        this.#assertAgentId(agentId);
        this.#assertInput(projectReorderInputSchema, input, "reorder");
        const normalized = structuredClone(input);
        const result = await this.#mutations.run(ctx, agentId, {
            action: "reorder",
            changeable: ["orderKey"],
            projectId: normalized.projectId,
            event: (after, before) => ({
                type: "project_reordered",
                agentId,
                previousOrderKey: before?.orderKey ?? after.orderKey,
                project: after,
            }),
            run: async (txCtx) =>
                await requirePromise(
                    this.#store.reorder(txCtx, agentId, normalized),
                    "Project store reorder",
                ),
        });
        return requireProjectFromResult(result);
    }

    async setAvatar(ctx: Context, agentId: string, input: ProjectSetAvatarInput): Promise<Project> {
        this.#assertAgentId(agentId);
        this.#assertInput(projectSetAvatarInputSchema, input, "avatar");
        const normalized = structuredClone(input);
        const result = await this.#mutations.run(ctx, agentId, {
            action: "avatar_update",
            changeable: ["avatar"],
            projectId: normalized.projectId,
            event: (after) => ({ type: "project_avatar_updated", agentId, project: after }),
            run: async (txCtx) =>
                await requirePromise(
                    this.#store.setAvatar(txCtx, agentId, normalized),
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
        agentId: string,
        input: ProjectClearAvatarInput,
    ): Promise<Project> {
        this.#assertAgentId(agentId);
        this.#assertInput(projectClearAvatarInputSchema, input, "avatar clear");
        const normalized = structuredClone(input);
        const result = await this.#mutations.run(ctx, agentId, {
            action: "avatar_update",
            changeable: ["avatar"],
            projectId: normalized.projectId,
            event: (after) => ({ type: "project_avatar_cleared", agentId, project: after }),
            run: async (txCtx) =>
                await requirePromise(
                    this.#store.clearAvatar(txCtx, agentId, normalized),
                    "Project store clear avatar",
                ),
        });
        const project = requireProjectFromResult(result);
        if (project.avatar !== undefined) {
            throw new Error("The project still has an avatar after it was cleared.");
        }
        return project;
    }

    async avatarAsset(
        ctx: Context,
        agentId: string,
        hash: string,
    ): Promise<ProjectAvatarAsset | undefined> {
        this.#assertAgentId(agentId);
        if (!Value.Check(projectAvatarHashSchema, hash)) {
            throw new Error("The project avatar hash is invalid.");
        }
        const project = await this.#store.findByAvatarHash(ctx, agentId, hash);
        if (project === undefined) return undefined;
        assertProject(project);
        assertProjectRecord(project);
        await this.#mutations.authorize(ctx, agentId, project.ownerAgentId, "avatar_read");
        const reader = this.#avatarAssetReader;
        if (reader === undefined) return undefined;
        const raw = await reader.read.call(reader, ctx, agentId, hash);
        if (raw === undefined) return undefined;
        assertProjectAvatarAsset(raw);
        if (
            raw.hash !== hash ||
            raw.bytes.byteLength > MAX_PROJECT_AVATAR_BYTES ||
            raw.mediaType !== "image/webp"
        ) {
            throw new Error("The project avatar reader returned an unrelated asset.");
        }
        return structuredClone(raw);
    }

    async updateSettings(
        ctx: Context,
        agentId: string,
        input: ProjectSettingsUpdateInput,
    ): Promise<ProjectSettingsUpdateResult> {
        this.#assertAgentId(agentId);
        this.#assertInput(projectSettingsUpdateInputSchema, input, "settings update");
        assertProjectSettings(input.settings);
        const normalized = structuredClone(input);
        return await ctx.inTx(async (txCtx) => {
            const before = await this.#mutations.getRequired(txCtx, agentId, normalized.projectId);
            await this.#mutations.authorize(txCtx, agentId, before.ownerAgentId, "settings_update");
            const beforeSettings = await this.#mutations.readSettings(txCtx, agentId, normalized.projectId);
            const raw = await requirePromise(
                this.#store.updateSettings(txCtx, agentId, normalized),
                "Project store update settings",
            );
            assertProjectStoreMutationResult(raw);
            if (raw.operation !== "update_settings" || raw.projectId !== normalized.projectId) {
                throw new Error("The settings result does not match the requested project.");
            }
            assertProjectSettings(raw.settings);
            const after = await this.#mutations.getRequired(txCtx, agentId, normalized.projectId);
            const afterSettings = await this.#mutations.readSettings(txCtx, agentId, normalized.projectId);
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
                    await this.#mutations.newEvent(txCtx, agentId, {
                        type: "project_settings_updated",
                        agentId,
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
    async probe(ctx: Context, agentId: string, projectId: string): Promise<Project> {
        const { compute, project } = await this.#lookAt(ctx, agentId, projectId, "update_state");
        const probe = await probeProjectRepository(ctx, compute, {
            isHome: project.kind === "home",
            path: project.repositoryRef,
        });
        return await this.applyProbe(ctx, agentId, {
            projectId,
            presence: probe.presence,
            worktreeSupport: probe.worktreeSupport,
            ...(probe.worktreeUnsupportedReason === undefined
                ? {}
                : { worktreeUnsupportedReason: boundedReason(probe.worktreeUnsupportedReason) }),
            ...(probe.facts === undefined ? {} : { git: probe.facts }),
        });
    }

    /**
     * Decides the trunk from the repository itself. Git resolves upward from a folder, so this
     * only asks when the folder is a repository root: a plain directory inside somebody else's
     * repository must not inherit their branch.
     */
    async resolveDefaultBranch(ctx: Context, agentId: string, projectId: string): Promise<Project> {
        const { compute, project } = await this.#lookAt(ctx, agentId, projectId, "update_state");
        if (project.defaultBranch !== undefined) return project;
        if (!(await this.#isRepositoryRoot(ctx, compute, project))) return project;
        const branch = await detectProjectDefaultBranch(ctx, compute, project.repositoryRef);
        if (branch === undefined) return project;
        return await this.setDefaultBranch(ctx, agentId, { projectId, branch });
    }

    /**
     * Takes the name the remote repository gives itself. A name a person chose is left alone, and
     * so is a folder that is not a repository root or has no usable remote.
     */
    async resolveRemoteName(ctx: Context, agentId: string, projectId: string): Promise<Project> {
        const { compute, project } = await this.#lookAt(ctx, agentId, projectId, "update_state");
        if (project.nameSource !== "folder") return project;
        if (!(await this.#isRepositoryRoot(ctx, compute, project))) return project;
        const remote = await selectProjectRemoteUrl(ctx, compute, project.repositoryRef);
        const name = remote === undefined ? undefined : remoteProjectName(remote);
        if (name === undefined) return project;
        return await this.adoptRemoteName(ctx, agentId, { projectId, name });
    }

    /** Records what a host probe of the project folder observed. */
    async applyProbe(ctx: Context, agentId: string, input: ProjectProbeInput): Promise<Project> {
        this.#assertInput(projectProbeInputSchema, input, "probe");
        const normalized = structuredClone(input);
        return await this.#changeState(ctx, agentId, normalized.projectId, "probe", () => ({
            presence: normalized.presence,
            worktreeSupport: normalized.worktreeSupport,
            worktreeUnsupportedReason: normalized.worktreeUnsupportedReason ?? null,
            ...(normalized.git === undefined ? {} : gitChanges(normalized.git)),
        }));
    }

    /** Records the branch, head, upstream and divergence a host read from Git. */
    async applyGitFacts(
        ctx: Context,
        agentId: string,
        input: ProjectGitFactsInput,
    ): Promise<Project> {
        this.#assertInput(projectGitFactsInputSchema, input, "Git facts");
        const normalized = structuredClone(input);
        return await this.#changeState(ctx, agentId, normalized.projectId, "git_facts", () =>
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
        agentId: string,
        input: ProjectSetDefaultBranchInput,
    ): Promise<Project> {
        this.#assertInput(projectSetDefaultBranchInputSchema, input, "default branch");
        const normalized = structuredClone(input);
        return await this.#changeState(
            ctx,
            agentId,
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
        agentId: string,
        input: ProjectAdoptRemoteNameInput,
    ): Promise<Project> {
        this.#assertInput(projectAdoptRemoteNameInputSchema, input, "remote name");
        const normalized = structuredClone(input);
        return await this.#changeState(
            ctx,
            agentId,
            normalized.projectId,
            "remote_name",
            (project) =>
                project.nameSource === "folder"
                    ? { name: normalized.name, nameSource: "remote" }
                    : undefined,
        );
    }

    /** The clone has landed, so the folder now exists. */
    async markCloneReady(ctx: Context, agentId: string, projectId: string): Promise<Project> {
        return await this.#changeState(ctx, agentId, projectId, "clone_ready", (project) =>
            project.initializationStatus === "initializing" ? { presence: "present" } : undefined,
        );
    }

    async markInitializationReady(
        ctx: Context,
        agentId: string,
        projectId: string,
    ): Promise<Project> {
        return await this.#changeState(
            ctx,
            agentId,
            projectId,
            "initialization_ready",
            (project) =>
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
        agentId: string,
        input: ProjectInitializationFailureInput,
    ): Promise<Project> {
        this.#assertInput(projectInitializationFailureInputSchema, input, "initialization failure");
        const normalized = structuredClone(input);
        return await this.#changeState(
            ctx,
            agentId,
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
    async retryInitialization(ctx: Context, agentId: string, projectId: string): Promise<Project> {
        return await this.#changeState(
            ctx,
            agentId,
            projectId,
            "initialization_retried",
            (project) =>
                project.initializationStatus === "failed"
                    ? { initializationStatus: "initializing", initializationError: null }
                    : undefined,
        );
    }

    /** Asks for the project to be set up again, whatever state it reached. */
    async refresh(ctx: Context, agentId: string, projectId: string): Promise<Project> {
        return await this.#changeState(ctx, agentId, projectId, "refresh", (project) =>
            project.kind === "home"
                ? undefined
                : {
                      initializationStatus: "initializing",
                      initializationAttempt: nextAttempt(project),
                      initializationError: null,
                  },
        );
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

    /** The project and the machine it lives on, with the acting agent already authorized. */
    async #lookAt(
        ctx: Context,
        agentId: string,
        projectId: string,
        action: ProjectAuthorizationAction,
    ): Promise<{ compute: HostCompute; project: Project }> {
        this.#assertAgentId(agentId);
        this.#assertId(projectId);
        const project = await this.#mutations.getRequired(ctx, agentId, projectId);
        await this.#mutations.authorize(ctx, agentId, project.ownerAgentId, action);
        return {
            compute: await requireProjectCompute(ctx, this.#compute, agentId),
            project,
        };
    }

    /**
     * Whether Git considers this exact folder a repository root, rather than somewhere inside one.
     */
    async #isRepositoryRoot(
        ctx: Context,
        compute: HostCompute,
        project: Project,
    ): Promise<boolean> {
        if (project.kind === "home") return false;
        const topLevel = await readProjectGit(ctx, compute, project.repositoryRef, [
            "rev-parse",
            "--show-toplevel",
        ]);
        if (topLevel === undefined) return false;
        return (
            (await realProjectPath(compute, topLevel)) ===
            (await realProjectPath(compute, project.repositoryRef))
        );
    }

    async #changeState(
        ctx: Context,
        agentId: string,
        projectId: string,
        reason: ProjectStateChangeReason,
        compute: (project: Project) => ProjectStateChanges | undefined,
    ): Promise<Project> {
        this.#assertAgentId(agentId);
        this.#assertId(projectId);
        const result = await this.#mutations.run(ctx, agentId, {
            action: "update_state",
            changeable: PROJECT_STATE_FIELDS,
            projectId,
            event: (after) => ({
                type: "project_state_changed",
                agentId,
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
                        agentId,
                        changed: false,
                        project: before,
                    };
                }
                return await requirePromise(
                    this.#store.applyState(txCtx, agentId, { projectId, changes }),
                    "Project store state change",
                );
            },
        });
        return requireProjectFromResult(result);
    }

    /**
     * Runs one durable catalog write: it reads the project the operation names,
     * authorizes the acting agent, checks the store's answer against the row
     * that is actually stored, and emits one event when something changed.
     */
    async #newIdentity(ctx: Context, agentId: string): Promise<string> {
        const raw = this.#idFactory(ctx, agentId);
        const value = isPromiseLike(raw) ? await raw : raw;
        if (!Value.Check(projectIdSchema, value)) {
            throw new Error("The project identity factory returned an invalid identity.");
        }
        return value;
    }

    #assertAgentId(agentId: string): void {
        if (!Value.Check(projectAgentIdSchema, agentId)) {
            throw new Error("The project agent ID is invalid.");
        }
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

/** A folder's real path, so two spellings of the same directory compare equal. */
async function realProjectPath(compute: HostCompute, path: string): Promise<string> {
    try {
        return await compute.fs.realpath(computePermissions("read_only"), path);
    } catch {
        return path;
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

