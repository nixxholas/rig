import type { ProjectCreator } from "../git/index.js";

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
