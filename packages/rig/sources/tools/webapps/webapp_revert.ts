import { Type } from "@sinclair/typebox";

import { defineTool } from "../../agent/types.js";
import { quoteVisibleExact } from "../../permissions/quoteVisibleExact.js";
import { webappSchema } from "../../protocol/WebappProtocol.js";
import { requireSlots } from "../slots/requireSlots.js";

export const webappRevertTool = defineTool({
    name: "webapp_revert",
    label: "Revert webapp",
    description:
        "Make a specific existing version of a webapp current. No versions are deleted; rig simply serves the chosen version again.",
    arguments: Type.Object(
        {
            name: Type.String({ description: "The webapp to revert." }),
            version: Type.Integer({
                minimum: 1,
                description: "The existing version to make current.",
            }),
        },
        { additionalProperties: false },
    ),
    returnType: webappSchema,
    requiresAutoOrFullAccess: true,
    shouldReviewInAutoMode: () => true,
    shouldRunInFullAccessInAutoMode: () => true,
    describeAutoPermissionAction: ({ name, version }) =>
        `make version v${String(version)} of the webapp ${quoteVisibleExact(name)} current without deleting any version`,
    execute: ({ name, version }, context) => requireSlots(context).revertWebapp(name, { version }),
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) =>
        `Reverted the ${result.name} webapp to version v${String(result.currentVersion)}.`,
    locks: ["webapps"],
});
