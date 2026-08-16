import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    projectSchema,
    projectSetAvatarInputSchema,
    type ProjectSetAvatarInput,
} from "../Project.js";
import type { ProjectsModule } from "../ProjectsModule.js";

export function setProjectAvatarTool(projects: ProjectsModule, agentId: string) {
    return defineAgentTool({
        name: "set_project_avatar",
        description:
            "Set normalized project avatar metadata. The host serves the image bytes for the returned hash.",
        parameters: projectSetAvatarInputSchema,
        returnType: projectSchema,
        durable: true,
        transactional: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: ProjectSetAvatarInput) =>
            await projects.setAvatar(ctx, agentId, input),
        toLLM: (project) => [
            {
                type: "text",
                text: projects.formatProjectForModel("Project avatar updated:", project),
            },
        ],
    });
}
