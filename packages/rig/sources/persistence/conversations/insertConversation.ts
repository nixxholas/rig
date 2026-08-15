import type { Context } from "@steve.kite/stdlib";

import type { Model } from "../../protocol/index.js";
import type { ConversationRecord } from "../../conversations/ConversationRecord.js";
import { sessionCredentialBindings, sessions } from "../database/schema.js";

/**
 * Inserts the product conversation row.
 *
 * The empty JSON fields are compatibility values for required columns that predate feature-owned
 * state. Nothing in the conversation repository reads or projects them; the database-generation
 * change that removes those columns can delete these values with them.
 */
export async function insertConversation(
    ctx: Context,
    record: ConversationRecord,
    models: readonly Model[],
): Promise<boolean> {
    const values: typeof sessions.$inferInsert = {
        ...scopeValues(record.scope),
        activeRunId: null,
        activeSinceMs: null,
        agentId: record.agentId,
        appendSystemPrompt: record.appendSystemPrompt ?? null,
        archived: record.archived,
        createdAtMs: record.createdAt,
        cwd: record.cwd,
        delegatedBySessionId: record.agent.delegatedBySessionId ?? null,
        depth: record.agent.depth,
        description: record.agent.description ?? null,
        dockerJson: record.execution === undefined ? null : JSON.stringify(record.execution),
        draft: null,
        draftUpdatedAtMs: null,
        effort: record.effort ?? null,
        elapsedMs: 0,
        goalJson: null,
        id: record.id,
        instructions: record.instructions ?? null,
        interrupted: false,
        interruptionJson: null,
        lastEventId: null,
        lastMessageAtMs: null,
        lifetimeTotalTokens: 0,
        metadataRunId: null,
        metadataUpdatedAtMs: null,
        modelId: record.modelId,
        modelsJson: JSON.stringify(models),
        nextTaskId: 1,
        orderKey: record.orderKey,
        ownerInstanceId: record.ownerInstanceId,
        parentSessionId: record.agent.parentSessionId ?? null,
        parentToolCallId: record.agent.parentToolCallId ?? null,
        permissionMode: record.permissionMode,
        profileId: record.profileId ?? null,
        providerId: record.providerId,
        recap: null,
        rootSessionId: record.agent.rootSessionId,
        secretIdsJson: "[]",
        serviceTier: record.serviceTier ?? null,
        sessionKind: record.agent.type,
        sessionTokenCountJson: null,
        status: "idle",
        systemPrompt: null,
        taskName: record.agent.taskName ?? null,
        tasksJson: "[]",
        title: record.agent.description ?? null,
        titleError: null,
        titleStatus: record.agent.description === undefined ? "idle" : "ready",
        toolsJson: "[]",
        totalTokens: 0,
        trackUnread: record.trackUnread,
        unreadReason: null,
        unreadSinceMs: null,
        unsortedSinceMs: record.scope.kind === "unsorted" ? record.createdAt : null,
        updatedAtMs: record.createdAt,
        usageJson: null,
        workflowsEnabled: true,
        workflowsJson: "[]",
        workspaceTransferJson: '{"status":"idle"}',
    };
    const inserted =
        (
            await ctx.tx
                .insert(sessions)
                .values(values)
                .onConflictDoNothing({ target: sessions.id })
                .run()
        ).rowsAffected > 0;
    if (!inserted) return false;
    await ctx.tx
        .insert(sessionCredentialBindings)
        .values({
            bindingId: `${record.ownerInstanceId}:${record.providerId}`,
            sessionId: record.id,
        })
        .run();
    return true;
}

function scopeValues(scope: ConversationRecord["scope"]): {
    folderId: string | null;
    projectId: string | null;
    scopeKind: ConversationRecord["scope"]["kind"];
    workspaceId: string | null;
} {
    switch (scope.kind) {
        case "project":
            return {
                folderId: null,
                projectId: scope.projectId,
                scopeKind: scope.kind,
                workspaceId: null,
            };
        case "workspace":
            return {
                folderId: null,
                projectId: scope.projectId,
                scopeKind: scope.kind,
                workspaceId: scope.workspaceId,
            };
        case "folder":
            return {
                folderId: scope.folderId,
                projectId: null,
                scopeKind: scope.kind,
                workspaceId: null,
            };
        case "unsorted":
            return {
                folderId: null,
                projectId: null,
                scopeKind: scope.kind,
                workspaceId: null,
            };
    }
}
