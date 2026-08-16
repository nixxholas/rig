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
            "Remove the avatar metadata from one project. Host-owned avatar bytes are not deleted by this catalog operation.",
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
                text: projects.formatProjectOperationForModel("Project avatar cleared:", project),
            },
        ],
    });
}
