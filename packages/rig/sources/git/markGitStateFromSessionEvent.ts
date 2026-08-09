import type { SessionEvent } from "../protocol/index.js";
import type { GitStateTracker } from "./GitStateTracker.js";
import { resolveGitTrackedEntity } from "./resolveGitTrackedEntity.js";
import type { SessionStore } from "../session/SessionStore.js";

/**
 * Marks a session's project or workspace as possibly changed when the agent does work.
 *
 * Rig is the process making most of the changes in a managed workspace, so its own activity is the
 * cheapest and fastest change signal available: no descriptors, no polling, and it fires on Linux
 * where a kernel-recursive working-tree watch is not available.
 *
 * No attempt is made to decide which tools write. That would either need a tool-name list, which
 * CLAUDE.md forbids for behavioural dispatch, or a per-tool declaration that a read-only tool could
 * still violate by invoking something that writes. `markChanged` already means "may have changed":
 * the tracker debounces, and a scan that finds nothing different publishes nothing, so an extra
 * signal costs one coalesced scan and never a wrong answer.
 */
export async function markGitStateFromSessionEvent(
    event: SessionEvent,
    store: SessionStore,
    tracker: GitStateTracker,
    /**
     * The live session the observer was already handed. Re-fetching it would rebuild the whole
     * protocol snapshot — filtering, sorting, and mapping every message — and would additionally
     * fire session-access notifications, on every tool execution.
     */
    live?: { projectId: string; workspaceId?: string },
): Promise<void> {
    if (!isWorkSignal(event)) return;
    const loaded = live ?? (await store.get(event.sessionId))?.projectIdentity();
    if (loaded === undefined) return;
    const project = await store.getProject(loaded.projectId);
    if (project === undefined) return;
    const workspace =
        loaded.workspaceId === undefined
            ? undefined
            : await store.getWorkspace(loaded.projectId, loaded.workspaceId);
    const entity = resolveGitTrackedEntity(project, workspace);
    if (entity === undefined) return;
    tracker.markChanged(entity);
}

/**
 * Events that mean the agent may have touched the filesystem. Run completion is included so the
 * final state of a turn is always scanned even if its last tool produced no event of its own.
 */
function isWorkSignal(event: SessionEvent): boolean {
    if (event.type === "run_finished") return true;
    if (event.type === "shell_command_finished") return true;
    return event.type === "agent_event" && event.data.event.type === "tool_execution_end";
}
