import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    projectCreateToolInputSchema,
    projectSchema,
    type ProjectCreateToolInput,
} from "../Project.js";
import type { ProjectsModule } from "../ProjectsModule.js";

export function createProjectTool(projects: ProjectsModule, agentId: string) {
    return defineAgentTool({
        name: "create_project",
        description:
            "Register a folder as a new project. The folder must be an absolute path no project uses yet; call ensure_project instead when it may already be registered. The new project starts out as still being set up.",
        parameters: projectCreateToolInputSchema,
        returnType: projectSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        transactional: true,
        execute: async (ctx, input: ProjectCreateToolInput) =>
            await projects.create(ctx, agentId, input),
        toLLM: (project) => [
            {
                type: "text",
                text: projects.formatProjectForModel("Project created:", project),
            },
        ],
    });
}
