import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import { workspaceAgentIdSchema, workspaceTimestampSchema } from "./Workspace.js";
import { workspaceContextSchema } from "./WorkspaceEvent.js";

/**
 * Where every workspace timestamp comes from. A host that controls time controls it everywhere the
 * module writes it — the reservation, each later change, and each event — so a catalog rebuilt in a
 * test or replayed against a fake clock tells one consistent story.
 */
export const workspaceClockSchema = Type.Function(
    [workspaceContextSchema, workspaceAgentIdSchema],
    workspaceTimestampSchema,
);

export type WorkspaceClock = Static<typeof workspaceClockSchema>;

/** Reads the clock, refusing an answer that could not be a moment in time. */
export function workspaceNow(clock: WorkspaceClock, ctx: Context, agentId: string): number {
    const at = clock(ctx, agentId);
    if (!Value.Check(workspaceTimestampSchema, at)) {
        throw new Error("Workspace clock must return a non-negative integer.");
    }
    return at;
}
