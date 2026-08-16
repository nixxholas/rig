import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    projectSettingsUpdateInputSchema,
    type ProjectSettingsUpdateInput,
} from "../ProjectSettings.js";
import {
    projectSettingsUpdateResultSchema,
    type ProjectSettingsUpdateResult,
} from "../ProjectStore.js";
import type { ProjectsModule } from "../ProjectsModule.js";

export function updateProjectSettingsTool(projects: ProjectsModule, agentId: string) {
    return defineAgentTool({
        name: "update_project_settings",
        description:
            "Replace one project's settings. The only setting is where new workspaces of that project run: locally, or in Docker with a named image. Pass an empty object to fall back to the host default.",
        parameters: projectSettingsUpdateInputSchema,
        returnType: projectSettingsUpdateResultSchema,
        durable: true,
        transactional: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: ProjectSettingsUpdateInput) =>
            await projects.updateSettings(ctx, agentId, input),
        toLLM: (result: ProjectSettingsUpdateResult) => [
            {
                type: "text",
                text: projects.formatSettingsForModel(result.projectId, result.settings),
            },
        ],
    });
}
