import { defineAgentTool } from "@slopus/happy-agent-base";

import { projectSchema, projectUnarchiveInputSchema } from "../Project.js";
import type { ProjectsModule } from "../ProjectsModule.js";

export function unarchiveProjectTool(projects: ProjectsModule, agentId: string) {
    return defineAgentTool({
        name: "unarchive_project",
        description:
            "Restore one archived project to the active catalog. The opaque repository reference and project identity remain unchanged.",
        parameters: projectUnarchiveInputSchema,
        returnType: projectSchema,
        durable: true,
        transactional: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { projectId }) => await projects.unarchive(ctx, agentId, projectId),
        toLLM: (project) => [
            {
                type: "text",
                text: projects.formatProjectOperationForModel("Project restored:", project),
            },
        ],
    });
}
