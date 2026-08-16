import { defineAgentTool } from "@slopus/happy-agent-base";

import { projectReorderInputSchema, projectSchema, type ProjectReorderInput } from "../Project.js";
import type { ProjectsModule } from "../ProjectsModule.js";

export function reorderProjectTool(projects: ProjectsModule, agentId: string) {
    return defineAgentTool({
        name: "reorder_project",
        description:
            "Move one project in the main project list. Set afterId to null for the beginning or to another project ID to place this project immediately after it.",
        parameters: projectReorderInputSchema,
        returnType: projectSchema,
        durable: true,
        transactional: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: ProjectReorderInput) =>
            await projects.reorder(ctx, agentId, input),
        toLLM: (project) => [
            {
                type: "text",
                text: projects.formatProjectOperationForModel("Project reordered:", project),
            },
        ],
    });
}
