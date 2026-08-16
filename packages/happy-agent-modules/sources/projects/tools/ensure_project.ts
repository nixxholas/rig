import { defineAgentTool } from "@slopus/happy-agent-base";

import { projectEnsureInputSchema, type ProjectEnsureInput } from "../Project.js";
import { projectEnsureResultSchema, type ProjectEnsureResult } from "../ProjectStore.js";
import type { ProjectsModule } from "../ProjectsModule.js";

export function ensureProjectTool(projects: ProjectsModule, agentId: string) {
    return defineAgentTool({
        name: "ensure_project",
        description:
            "Make sure one absolute folder path is registered exactly once. An existing project for that folder is returned with created=false, an archived one is brought back, and a folder nothing knows about becomes a new project with created=true.",
        parameters: projectEnsureInputSchema,
        returnType: projectEnsureResultSchema,
        durable: true,
        transactional: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: ProjectEnsureInput) =>
            await projects.ensure(ctx, agentId, input),
        toLLM: (result: ProjectEnsureResult) => [
            {
                type: "text",
                text: projects.formatProjectForModel(
                    result.created
                        ? "Project created for this folder:"
                        : "This folder is already a project:",
                    result.project,
                ),
            },
        ],
    });
}
