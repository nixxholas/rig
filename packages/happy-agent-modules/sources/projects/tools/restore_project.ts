import { defineAgentTool } from "@slopus/happy-agent-base";

import { projectByIdInputSchema, projectSchema } from "../Project.js";
import type { ProjectsModule } from "../ProjectsModule.js";

export function restoreProjectTool(projects: ProjectsModule, agentId: string) {
    return defineAgentTool({
        name: "restore_project",
        description:
            "Bring one archived project back to the active catalog. Its folder, identity and settings are unchanged.",
        parameters: projectByIdInputSchema,
        returnType: projectSchema,
        durable: true,
        transactional: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { projectId }) => await projects.restore(ctx, agentId, projectId),
        toLLM: (project) => [
            {
                type: "text",
                text: projects.formatProjectForModel("Project restored:", project),
            },
        ],
    });
}
