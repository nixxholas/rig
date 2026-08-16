import { defineAgentTool } from "@slopus/happy-agent-base";

import { projectRenameInputSchema, projectSchema, type ProjectRenameInput } from "../Project.js";
import type { ProjectsModule } from "../ProjectsModule.js";

export function renameProjectTool(projects: ProjectsModule, agentId: string) {
    return defineAgentTool({
        name: "rename_project",
        description:
            "Change a project's display name. The name then counts as chosen by a person, so a remote repository's name will not replace it later. The folder and every other identity field stay as they are.",
        parameters: projectRenameInputSchema,
        returnType: projectSchema,
        durable: true,
        transactional: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: ProjectRenameInput) =>
            await projects.rename(ctx, agentId, input),
        toLLM: (project) => [
            {
                type: "text",
                text: projects.formatProjectForModel("Project renamed:", project),
            },
        ],
    });
}
