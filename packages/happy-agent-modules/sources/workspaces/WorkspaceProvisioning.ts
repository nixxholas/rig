import { Type } from "@sinclair/typebox";
import type { RootContext } from "@steve.kite/stdlib";

import type { GitCommandRunner } from "../git/GitCommandRunner.js";
import type { ProjectCreator } from "../git/types.js";
import type { ProjectsModule } from "../projects/ProjectsModule.js";

import type { WorkspaceFolderSettings } from "./impl/loadWorkspaceFolderSettings.js";

/** What a caller asks for when it wants one new workspace in a project. */
export interface CreateWorkspaceRequest {
    readonly baseRef?: string;
    readonly id?: string;
    readonly name: string;
    readonly nameConfigured?: boolean;
    readonly secret?: { readonly kind: "github" };
}

/** Who asked for the workspace, and with which credential. */
export interface WorkspaceCreatorOptions {
    readonly createdBy?: ProjectCreator;
    readonly githubToken?: string;
}

export const workspaceProjectsModuleSchema = Type.Unsafe<ProjectsModule>(
    Type.Object({}, { additionalProperties: true }),
);
export const workspaceRootContextSchema = Type.Unsafe<RootContext>(
    Type.Object({}, { additionalProperties: true }),
);
export const workspaceGitRunnerSchema = Type.Unsafe<GitCommandRunner>(
    Type.Object({}, { additionalProperties: true }),
);
export const workspaceEnvironmentSchema = Type.Unsafe<NodeJS.ProcessEnv>(
    Type.Object({}, { additionalProperties: true }),
);
export const workspaceFolderSettingsOptionSchema = Type.Unsafe<WorkspaceFolderSettings>(
    Type.Object({}, { additionalProperties: true }),
);
