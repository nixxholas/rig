import type { Context } from "@steve.kite/stdlib";

import { eq } from "drizzle-orm";

import type { SessionEvent } from "../../protocol/index.js";
import { sessions } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { SessionEventIndexFacts } from "./sessionAppendEvent.js";
import { sessionAppendEvent } from "./sessionAppendEvent.js";

export async function sessionProjectProtocolEvent(
    ctx: Context,
    event: SessionEvent,
    facts: SessionEventIndexFacts,
    updatedAt: number,
): Promise<"existing" | "inserted"> {
    return await inTx(ctx, "rig.sql.session.project_protocol_event", async (ctx) => {
        const inserted = await sessionAppendEvent(ctx, event, facts, updatedAt);
        if (inserted === "existing") return inserted;
        const update = lifecycleUpdate(event);
        if (update !== undefined) {
            await ctx.tx
                .update(sessions)
                .set({ ...update, updatedAtMs: updatedAt })
                .where(eq(sessions.id, event.sessionId))
                .run();
        }
        return inserted;
    });
}

function lifecycleUpdate(event: SessionEvent): Partial<typeof sessions.$inferInsert> | undefined {
    switch (event.type) {
        case "run_started":
            return {
                activeRunId: event.data.runId,
                activeSinceMs: event.createdAt,
                status: "running",
            };
        case "run_finished":
            return {
                activeRunId: null,
                activeSinceMs: null,
                status:
                    event.data.stopReason === "aborted"
                        ? "aborted"
                        : event.data.stopReason === "error"
                          ? "error"
                          : "completed",
            };
        case "run_error":
            return {
                activeRunId: null,
                activeSinceMs: null,
                status: "error",
            };
        case "abort_requested":
            return event.data.continuePendingSteering === true
                ? undefined
                : {
                      activeRunId: null,
                      activeSinceMs: null,
                      status: "aborted",
                  };
        case "session_status_changed":
            return { status: event.data.status };
        case "session_archived":
            return {
                archived: event.data.archived,
                ...(event.data.archived ? { status: "archived" } : {}),
            };
        case "session_context_changed":
            return { sessionTokenCountJson: JSON.stringify(event.data.sessionTokenCount) };
        case "session_title_changed":
            return {
                metadataRunId: event.data.metadataRunId ?? null,
                metadataUpdatedAtMs: event.data.metadataUpdatedAt ?? null,
                recap: event.data.recap ?? null,
                title: event.data.title ?? null,
                titleError: event.data.errorMessage ?? null,
                titleStatus: event.data.status,
            };
        default:
            return undefined;
    }
}
