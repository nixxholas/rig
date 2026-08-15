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
            "Register a repository as a new project with a display name. The repository reference is opaque to the module and is supplied by the host or agent context. The result includes the complete project identity and detail.",
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
                text: projects.formatProjectOperationForModel("Project created:", project),
            },
        ],
    });
}
