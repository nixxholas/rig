import { Type } from "@sinclair/typebox";

import { defineTool } from "../../agent/types.js";
import { quoteVisibleExact } from "../../permissions/quoteVisibleExact.js";
import { webappAllowedScopesSchema, webappSchema } from "../../protocol/WebappProtocol.js";
import { getWebappsDirectory } from "../../webapps/getWebappsDirectory.js";
import { requireSlots } from "../slots/requireSlots.js";
import { assertShareableLocalPath } from "../attachments/assertShareableLocalPath.js";

export const webappCreateTool = defineTool({
    name: "webapp_create",
    label: "Create webapp",
    description:
        "Create a webapp by importing a source folder of static files and a required 512x512 PNG icon. Both sources must be inside the active workspace or Rig-generated media directory. Rig copies the folder into the webapp's data directory as version v1 and serves it over HTTP with index.html as the entry point; nothing is ever written into the webapp folder directly. The webapp may optionally limit which slot scopes can open it; the default is all scopes. The description says what the webapp is and the purpose says why it exists.",
    arguments: Type.Object(
        {
            name: Type.String({
                description: 'Human-readable kebab-case name, such as "usage-dashboard".',
            }),
            description: Type.String({ description: "What the webapp is." }),
            purpose: Type.String({ description: "Why the webapp exists." }),
            allowedScopes: Type.Optional(webappAllowedScopesSchema),
            path: Type.String({
                description: "Absolute path of the source folder to import.",
            }),
            iconPath: Type.String({
                description: "Absolute path of the required 512x512 PNG icon.",
            }),
            sourceDescription: Type.Optional(
                Type.String({
                    description: "Where the sources live, such as the project and folder.",
                }),
            ),
        },
        { additionalProperties: false },
    ),
    returnType: webappSchema,
    requiresAutoOrFullAccess: true,
    shouldReviewInAutoMode: () => true,
    shouldRunInFullAccessInAutoMode: () => true,
    describeAutoPermissionAction: ({ iconPath, name, path }) =>
        `import the folder ${quoteVisibleExact(path)} with icon ${quoteVisibleExact(iconPath)} as version v1 of the webapp ${quoteVisibleExact(name)} under ${quoteVisibleExact(getWebappsDirectory())}. Access: reads the source folder and icon, then copies files outside the workspace sandbox`,
    execute: async (args, context) => {
        await Promise.all([
            assertShareableLocalPath(args.path, context),
            assertShareableLocalPath(args.iconPath, context),
        ]);
        return requireSlots(context).createWebapp(args, context.fs);
    },
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) => `Created the ${result.name} webapp at version v1.`,
    locks: ["webapps"],
});
