import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    appletSchema,
    appletToolImportInputSchema,
    type AppletToolImportInput,
} from "../Applet.js";
import type { AppletModule } from "../AppletModule.js";

/** Alias for callers that name applet creation an import. */
export function importAppletTool(applets: AppletModule, agentId: string) {
    return defineAgentTool({
        name: "import_applet",
        description:
            "Install a source folder as an applet. Give an absolute path to the folder; it is verified and copied in as version 1.",
        parameters: appletToolImportInputSchema,
        returnType: Type.Object({ applet: appletSchema }),
        durable: false,
        requiresAutoOrFullAccess: true,
        shouldReviewInAutoMode: () => true,
        shouldRunInFullAccessInAutoMode: () => true,
        describeAutoPermissionAction: (input) =>
            applets.describeImportAutoPermission(input, "import"),
        execute: async (ctx, input: AppletToolImportInput, call) => ({
            applet: await applets.importForAgent(ctx, agentId, input, call.id),
        }),
        toLLM: ({ applet }) => [
            {
                type: "text",
                text: applets.formatOperationForModel("Applet imported", applet),
            },
        ],
    });
}
