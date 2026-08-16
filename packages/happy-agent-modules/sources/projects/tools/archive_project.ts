import { defineAgentTool } from "@slopus/happy-agent-base";

import { projectByIdInputSchema, projectSchema } from "../Project.js";
import type { ProjectsModule } from "../ProjectsModule.js";

export function archiveProjectTool(projects: ProjectsModule, agentId: string) {
    return defineAgentTool({
        name: "archive_project",
        description:
            "Archive one project. Archival is the durable decision and is never rolled back: the host then deletes the project's managed folder and every worktree cut from it.",
        parameters: projectByIdInputSchema,
        returnType: projectSchema,
        durable: true,
        transactional: true,
        // Archival is what sets host cleanup in motion, so the call is reviewed
        // even though the catalog write itself never leaves the database.
        shouldReviewInAutoMode: () => true,
        describeAutoPermissionAction: ({ projectId }) =>
            `Archive project ${projectId}. The host then deletes that project's managed folder and every workspace worktree belonging to it. Archival stands even if the cleanup fails.`,
        execute: async (ctx, { projectId }) => await projects.archive(ctx, agentId, projectId),
        toLLM: (project) => [
            {
                type: "text",
                text: projects.formatProjectForModel("Project archived:", project),
            },
        ],
    });
}
