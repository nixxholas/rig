import { Type } from "@sinclair/typebox";

import { defineTool } from "../../agent/types.js";
import { quoteVisibleExact } from "../../permissions/quoteVisibleExact.js";
import { appletSchema } from "../../protocol/AppletProtocol.js";
import { requireSlots } from "../slots/requireSlots.js";

export const appletRevertTool = defineTool({
    name: "applet_revert",
    label: "Revert applet",
    description:
        "Make a specific existing version of an applet current. No versions are deleted; rig simply serves the chosen version again.",
    arguments: Type.Object(
        {
            name: Type.String({ description: "The applet to revert." }),
            version: Type.Integer({
                minimum: 1,
                description: "The existing version to make current.",
            }),
        },
        { additionalProperties: false },
    ),
    returnType: appletSchema,
    requiresAutoOrFullAccess: true,
    shouldReviewInAutoMode: () => true,
    shouldRunInFullAccessInAutoMode: () => true,
    describeAutoPermissionAction: ({ name, version }) =>
        `make version v${String(version)} of the applet ${quoteVisibleExact(name)} current without deleting any version`,
    execute: ({ name, version }, context) => requireSlots(context).revertApplet(name, { version }),
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) =>
        `Reverted the ${result.name} applet to version v${String(result.currentVersion)}.`,
    locks: ["applets"],
});
