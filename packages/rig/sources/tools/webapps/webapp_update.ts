import { Type } from "@sinclair/typebox";

import { defineTool } from "../../agent/types.js";
import { quoteVisibleExact } from "../../permissions/quoteVisibleExact.js";
import { webappAllowedScopesSchema, webappSchema } from "../../protocol/WebappProtocol.js";
import { getWebappsDirectory } from "../../webapps/getWebappsDirectory.js";
import { requireSlots } from "../slots/requireSlots.js";
import { assertShareableLocalPath } from "../attachments/assertShareableLocalPath.js";

export const webappUpdateTool = defineTool({
    name: "webapp_update",
    label: "Update webapp",
    description:
        "Import a new version of an existing webapp from a source folder inside the active workspace or Rig-generated media directory. The import becomes the next version (v2, v3, ...) and is made current; earlier versions are kept. The webapp's allowed slot scopes may also be changed. A description of the change is required.",
    arguments: Type.Object(
        {
            name: Type.String({ description: "The webapp to update." }),
            path: Type.String({
                description: "Absolute path of the source folder to import.",
            }),
            changeDescription: Type.String({ description: "What changed in this import." }),
            allowedScopes: Type.Optional(webappAllowedScopesSchema),
        },
        { additionalProperties: false },
    ),
    returnType: webappSchema,
    requiresAutoOrFullAccess: true,
    shouldReviewInAutoMode: () => true,
    shouldRunInFullAccessInAutoMode: () => true,
    describeAutoPermissionAction: ({ name, path }) =>
        `import the folder ${quoteVisibleExact(path)} as the next version of the webapp ${quoteVisibleExact(name)} under ${quoteVisibleExact(getWebappsDirectory())} and make it current. Access: copies files outside the workspace sandbox`,
    execute: async ({ name, ...request }, context) => {
        await assertShareableLocalPath(request.path, context);
        return requireSlots(context).updateWebapp(name, request, context.fs);
    },
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) =>
        `Updated the ${result.name} webapp to version v${String(result.currentVersion)}.`,
    locks: ["webapps"],
});
