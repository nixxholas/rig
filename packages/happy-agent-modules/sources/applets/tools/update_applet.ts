import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    appletChangeDescriptionSchema,
    appletDescriptionSchema,
    appletNameSchema,
    appletPurposeSchema,
    appletSchema,
    appletSourcePathSchema,
    appletScopeRefSchema,
    defaultAppletAllowedScopes,
    type AppletToolUpdateInput,
} from "../Applet.js";
import type { AppletModule } from "../AppletModule.js";

const updateAppletInputSchema = Type.Object(
    {
        name: appletNameSchema,
        path: appletSourcePathSchema,
        changeDescription: appletChangeDescriptionSchema,
        allowedScopes: Type.Optional(
            Type.Array(appletScopeRefSchema, {
                minItems: 1,
                maxItems: defaultAppletAllowedScopes.length,
                uniqueItems: true,
            }),
        ),
        description: Type.Optional(appletDescriptionSchema),
        purpose: Type.Optional(appletPurposeSchema),
        sourceDescription: Type.Optional(Type.String({ maxLength: 2_000 })),
    },
    { additionalProperties: false },
);

/** Import a new source version and update host-owned metadata. */
export function updateAppletTool(applets: AppletModule, agentId: string) {
    return defineAgentTool({
        name: "update_applet",
        description:
            "Import a new source version for an applet and optionally update its metadata.",
        parameters: updateAppletInputSchema,
        returnType: Type.Object({ applet: appletSchema }),
        durable: false,
        requiresAutoOrFullAccess: true,
        shouldReviewInAutoMode: () => true,
        shouldRunInFullAccessInAutoMode: () => true,
        describeAutoPermissionAction: ({ name, ...input }) =>
            applets.describeUpdateAutoPermission(name, input),
        execute: async (
            ctx,
            { name, ...input }: { name: string } & AppletToolUpdateInput,
            call,
        ) => ({
            applet: await applets.updateForAgent(ctx, agentId, name, input, call.id),
        }),
        toLLM: ({ applet }) => [
            {
                type: "text",
                text: applets.formatOperationForModel("Applet updated", applet),
            },
        ],
    });
}
