import { defineAgentTool } from "@slopus/happy-agent-base";

import { projectByIdInputSchema } from "../Project.js";
import { projectSettingsViewSchema } from "../ProjectSettings.js";
import type { ProjectsModule } from "../ProjectsModule.js";

export function getProjectSettingsTool(projects: ProjectsModule, agentId: string) {
    return defineAgentTool({
        name: "get_project_settings",
        description:
            "Read one project's settings: where new workspaces of that project run, when the project decides that itself.",
        parameters: projectByIdInputSchema,
        returnType: projectSettingsViewSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { projectId }) => ({
            projectId,
            settings: await projects.readSettings(ctx, agentId, projectId),
        }),
        toLLM: (view) => [
            { type: "text", text: projects.formatSettingsForModel(view.projectId, view.settings) },
        ],
    });
}
