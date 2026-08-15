import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    appletSchema,
    appletToolImportInputSchema,
    type AppletToolImportInput,
} from "../Applet.js";
import type { AppletModule } from "../AppletModule.js";

/** Create an applet by verifying and installing a source folder. */
export function createAppletTool(applets: AppletModule, agentId: string) {
    return defineAgentTool({
        name: "create_applet",
        description:
            "Create an applet by installing a source folder. Give an absolute path to the folder; it is verified and copied into the applets directory as version 1.",
        parameters: appletToolImportInputSchema,
        returnType: Type.Object({ applet: appletSchema }),
        durable: false,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: AppletToolImportInput, call) => ({
            applet: await applets.createForAgent(ctx, agentId, input, call.id),
        }),
        toLLM: ({ applet }) => [
            {
                type: "text",
                text: applets.formatOperationForModel("Applet created", applet),
            },
        ],
    });
}
