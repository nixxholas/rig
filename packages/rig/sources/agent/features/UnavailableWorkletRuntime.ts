import {
    assertWorkletRuntimeInvocationRequest,
    assertWorkletRuntimeLogQuery,
    type WorkletInvocationResult,
    type WorkletLogPage,
    type WorkletRuntime,
    type WorkletRuntimeInvocationRequest,
    type WorkletRuntimeLogQuery,
    type WorkletStatus,
} from "@slopus/happy-agent-features";
import type { Context } from "@steve.kite/stdlib";

const unavailableDetail =
    "Worklet process execution is unavailable because no worklet runtime is configured.";

/**
 * Honest host port used while Rig has no feature-compatible worklet process runtime.
 *
 * Catalog management remains available through WorkletsFeature. This adapter does
 * not revive the removed manager or claim a process is running.
 */
export class UnavailableWorkletRuntime implements WorkletRuntime {
    async status(_ctx: Context, name: string): Promise<WorkletStatus> {
        return { name, state: "stopped", detail: unavailableDetail, at: Date.now() };
    }

    async readLogs(_ctx: Context, query: WorkletRuntimeLogQuery): Promise<WorkletLogPage> {
        assertWorkletRuntimeLogQuery(query);
        if ((query.cursor ?? 0) !== 0) {
            throw new Error("Worklet logs are unavailable beyond the empty runtime log.");
        }
        return { name: query.name, cursor: 0, lines: [], totalLines: 0 };
    }

    async invokeOperation(
        _ctx: Context,
        request: WorkletRuntimeInvocationRequest,
    ): Promise<WorkletInvocationResult> {
        assertWorkletRuntimeInvocationRequest(request);
        throw new Error(unavailableDetail);
    }
}
