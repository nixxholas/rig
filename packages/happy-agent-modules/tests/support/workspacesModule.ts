import type { ConfigModule } from "../../sources/config/index.js";
import { GitModule } from "../../sources/git/index.js";
import { ProjectsModule } from "../../sources/projects/index.js";
import { WorkspacesModule } from "../../sources/workspaces/index.js";

import { temporaryTestConfig, testConfigRootedAt } from "./configModule.js";

/**
 * The three modules a workspace test drives, built the way the composition root builds them.
 *
 * Nothing here is a stand-in: the catalog runs real Git and reads the real filesystem, and where it
 * puts folders is whatever the configuration it was given says. `workspacesDirectory` is that
 * answer as the catalog itself resolves it, so a test can say where a folder should be without
 * repeating how the path was decided.
 */
export interface WorkspacesCatalog {
    readonly config: ConfigModule;
    readonly git: GitModule;
    readonly projects: ProjectsModule;
    readonly workspaces: WorkspacesModule;
    readonly workspacesDirectory: string;
}

export function workspacesCatalogFrom(config: ConfigModule): WorkspacesCatalog {
    const git = new GitModule();
    const projects = new ProjectsModule(config, git);
    return {
        config,
        git,
        projects,
        workspaces: new WorkspacesModule(config, projects, git),
        workspacesDirectory: git.normalizeFuturePath(config.workspacesHome),
    };
}

/** A catalog over a temporary Happy root nobody else is using. */
export async function temporaryWorkspacesCatalog(toml?: string): Promise<WorkspacesCatalog> {
    return workspacesCatalogFrom(await temporaryTestConfig(toml));
}

/** The same, over a folder the test made itself so it can look at what Git left there. */
export async function workspacesCatalogRootedAt(
    root: string,
    toml?: string,
): Promise<WorkspacesCatalog> {
    return workspacesCatalogFrom(await testConfigRootedAt(root, toml));
}
