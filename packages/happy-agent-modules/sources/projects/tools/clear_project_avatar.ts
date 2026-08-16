import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    projectClearAvatarInputSchema,
    projectSchema,
    type ProjectClearAvatarInput,
} from "../Project.js";
import type { ProjectsModule } from "../ProjectsModule.js";

export function clearProjectAvatarTool(projects: ProjectsModule, agentId: string) {
    return defineAgentTool({
        name: "clear_project_avatar",
        description:
            "Remove the avatar metadata from one project. The host keeps its stored image bytes; this only clears what the catalog points at.",
        parameters: projectClearAvatarInputSchema,
        returnType: projectSchema,
        durable: true,
        transactional: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: ProjectClearAvatarInput) =>
            await projects.clearAvatar(ctx, agentId, input),
        toLLM: (project) => [
            {
                type: "text",
                text: projects.formatProjectForModel("Project avatar cleared:", project),
            },
        ],
    });
}
