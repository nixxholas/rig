import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    workspacePageQuerySchema,
    workspacePageSchema,
    type WorkspacePageQuery,
} from "../WorkspacePage.js";
import type { WorkspacesModule } from "../WorkspacesModule.js";

/** List a bounded page of host-managed workspaces. */
export function listWorkspacesTool(workspaces: WorkspacesModule, agentId: string) {
    return defineAgentTool({
        name: "list_workspaces",
        description:
            "List a bounded page of persistent workspaces. Use nextCursor to continue reading the host catalog.",
        parameters: workspacePageQuerySchema,
        returnType: workspacePageSchema,
        durable: false,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, query: WorkspacePageQuery) =>
            await workspaces.listPage(ctx, agentId, query),
        toLLM: (page) => [
            {
                type: "text",
                text: workspaces.formatPageForModel(page),
            },
        ],
    });
}
