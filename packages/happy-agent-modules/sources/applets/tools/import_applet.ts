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
            "Install a source folder as an applet. Give an absolute path to the folder; it is verified and copied in as version 1. The module assigns a durable retry identity.",
        parameters: appletToolImportInputSchema,
        returnType: Type.Object({ applet: appletSchema }),
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: AppletToolImportInput) => ({
            applet: await applets.importForAgent(ctx, agentId, input),
        }),
        toLLM: ({ applet }) => [
            {
                type: "text",
                text: applets.formatOperationForModel("Applet imported", applet),
            },
        ],
    });
}
