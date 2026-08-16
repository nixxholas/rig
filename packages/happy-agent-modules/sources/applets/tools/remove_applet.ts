import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import { appletNameSchema } from "../Applet.js";
import type { AppletModule } from "../AppletModule.js";

const removeAppletInputSchema = Type.Object(
    { name: appletNameSchema },
    { additionalProperties: false },
);

/** Remove one applet through the host catalog. */
export function removeAppletTool(applets: AppletModule, agentId: string) {
    return defineAgentTool({
        name: "remove_applet",
        description: "Remove an applet from the host catalog.",
        parameters: removeAppletInputSchema,
        returnType: Type.Boolean(),
        durable: false,
        requiresAutoOrFullAccess: true,
        shouldReviewInAutoMode: () => true,
        shouldRunInFullAccessInAutoMode: () => true,
        describeAutoPermissionAction: ({ name }) => applets.describeRemoveAutoPermission(name),
        execute: async (ctx, { name }, call) =>
            await applets.removeForAgent(ctx, agentId, name, call.id),
        toLLM: (removed) => [{ type: "text", text: applets.formatRemovalForModel(removed) }],
    });
}
