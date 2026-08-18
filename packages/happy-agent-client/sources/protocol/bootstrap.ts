/** Bootstrap: one request that gets a desktop client on screen instantly. */

import type { EventCursor } from "./common.js";
import type { DaemonConfig, OnboardingState } from "./daemon.js";
import type { Profile } from "./profile.js";
import type { Project } from "./projects.js";
import type { Workspace } from "./workspaces.js";

/**
 * `GET /v0/bootstrap/desktop`
 *
 * A composition of other endpoints' objects; nothing here has a shape of its
 * own. Agents are intentionally absent — a workspace's agent list is fetched
 * when that workspace is opened.
 */
export interface DesktopBootstrapResponse {
    config: DaemonConfig;
    profile: Profile;
    onboarding: OnboardingState;
    /** Every active project, in catalog order. */
    projects: Project[];
    /** Each project's root workspace and the workspaces directly under it. */
    workspaces: Workspace[];
    /**
     * The newest event cursor as of this snapshot. Opening the event stream
     * from here leaves no window for a change to fall between the two.
     */
    cursor: EventCursor;
}
