import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import { projectByIdInputSchema, projectSchema } from "../Project.js";
import type { ProjectsModule } from "../ProjectsModule.js";

export function getProjectTool(projects: ProjectsModule, agentId: string) {
    return defineAgentTool({
        name: "get_project",
        description:
            "Read one project by ID: its folder, name, status, setup state, worktree support, default branch and cached Git facts.",
        parameters: projectByIdInputSchema,
        returnType: Type.Union([projectSchema, Type.Null()]),
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { projectId }) =>
            (await projects.get(ctx, agentId, projectId)) ?? null,
        toLLM: (project) => [
            {
                type: "text",
                text:
                    project === null
                        ? "That project does not exist."
                        : projects.formatProjectForModel("Project:", project),
            },
        ],
    });
}
