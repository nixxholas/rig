import type { Project, ProjectAvatar, GitRepositoryFacts } from "../../../protocol/index.js";
import type { projectAvatarAssets, projects } from "../../database/schema.js";

type ProjectRow = typeof projects.$inferSelect;
type ProjectAvatarAssetRow = Pick<
    typeof projectAvatarAssets.$inferSelect,
    "height" | "width"
> | null;

export function projectReadRow(row: ProjectRow, asset: ProjectAvatarAssetRow): Project {
    const git = projectReadGitFacts(row);
    const project: Project = {
        ...(row.archivedAtMs === null ? {} : { archivedAt: row.archivedAtMs }),
        createdAt: row.createdAtMs,
        ...(git === undefined ? {} : { git }),
        id: row.id,
        initializationAttempt: row.initializationAttempt,
        initializationStatus: row.initializationStatus as Project["initializationStatus"],
        kind: row.kind as Project["kind"],
        name: row.name,
        nameSource: row.nameSource as Project["nameSource"],
        orderKey: row.orderKey,
        path: row.path,
        presence: row.presence as Project["presence"],
        storageKey: row.storageKey,
        updatedAt: row.updatedAtMs,
        version: row.version,
        worktreeSupport: row.worktreeSupport as Project["worktreeSupport"],
        ...(row.worktreeSupportReason === null
            ? {}
            : { worktreeSupportReason: row.worktreeSupportReason }),
    };
    if (project.kind === "home" && row.avatarHash === null) project.avatarBuiltin = "home";
    if (row.initializationError !== null) {
        project.initializationError = row.initializationError;
    }
    if (row.avatarHash !== null && row.avatarSource !== null && asset !== null) {
        project.avatar = {
            hash: row.avatarHash,
            height: asset.height,
            mediaType: "image/webp",
            source: row.avatarSource as ProjectAvatar["source"],
            url: `/project-assets/${row.avatarHash}`,
            width: asset.width,
        };
    }
    return project;
}

function projectReadGitFacts(row: ProjectRow): GitRepositoryFacts | undefined {
    const branch = row.gitBranch ?? undefined;
    const head = row.gitHead ?? undefined;
    const upstream = row.gitUpstream ?? undefined;
    if (branch === undefined && head === undefined && !row.gitDetached) return undefined;
    return {
        ahead: row.gitAhead,
        behind: row.gitBehind,
        ...(branch === undefined ? {} : { branch }),
        detached: row.gitDetached,
        ...(head === undefined ? {} : { head }),
        ...(upstream === undefined ? {} : { upstream }),
    };
}
