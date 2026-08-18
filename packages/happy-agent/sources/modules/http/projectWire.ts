import type { Project, ProjectsModule } from "@slopus/happy-agent-modules";
import type { Context } from "@steve.kite/stdlib";

/**
 * The wire form of one project. Every field comes from the record, none is invented.
 *
 * Every route and the startup catalog answer with this same shape, so a client that opens with a
 * snapshot and one that reads a project directly are looking at the same project.
 */
export async function projectWire(
    ctx: Context,
    projects: ProjectsModule,
    project: Project,
): Promise<Record<string, unknown>> {
    const settings = await projects.readSettings(ctx, project.id).catch(() => ({}));
    return {
        archivedAt: project.archivedAt,
        avatar: project.avatar,
        createdAt: project.createdAt,
        defaultBranch: project.defaultBranch,
        description: project.description,
        git: {
            ahead: project.gitAhead,
            behind: project.gitBehind,
            branch: project.gitBranch,
            detached: project.gitDetached,
            head: project.gitHead,
            upstream: project.gitUpstream,
        },
        id: project.id,
        initializationAttempt: project.initializationAttempt,
        initializationError: project.initializationError,
        initializationStatus: project.initializationStatus,
        kind: project.kind,
        name: project.name,
        nameSource: project.nameSource,
        orderKey: project.orderKey,
        path: project.repositoryRef,
        presence: project.presence,
        remoteSource: project.remoteSource,
        requiredSecretKind: project.requiredSecretKind,
        settings,
        status: project.status,
        storageKey: project.storageKey,
        updatedAt: project.updatedAt,
        version: project.version,
        worktreeSupport: project.worktreeSupport,
        worktreeUnsupportedReason: project.worktreeUnsupportedReason,
    };
}
