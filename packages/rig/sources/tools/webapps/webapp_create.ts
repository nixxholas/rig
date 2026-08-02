import { Type } from "@sinclair/typebox";

import { defineTool } from "../../agent/types.js";
import { quoteVisibleExact } from "../../permissions/quoteVisibleExact.js";
import { webappSchema } from "../../protocol/WebappProtocol.js";
import { getWebappsDirectory } from "../../webapps/getWebappsDirectory.js";
import { requireSlots } from "../slots/requireSlots.js";

export const webappCreateTool = defineTool({
    name: "webapp_create",
    label: "Create webapp",
    description:
        "Create a webapp by importing a source folder of static files. Rig copies the folder into the webapp's data directory as version v1 and serves it over HTTP with index.html as the entry point; nothing is ever written into the webapp folder directly. The description says what the webapp is and the purpose says why it exists.",
    arguments: Type.Object(
        {
            name: Type.String({
                description: 'Human-readable kebab-case name, such as "usage-dashboard".',
            }),
            description: Type.String({ description: "What the webapp is." }),
            purpose: Type.String({ description: "Why the webapp exists." }),
            path: Type.String({
                description: "Absolute path of the source folder to import.",
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
    shouldReviewInAutoMode: () => true,
    describeAutoPermissionAction: ({ name, path }) =>
        `import the folder ${quoteVisibleExact(path)} as version v1 of the webapp ${quoteVisibleExact(name)} under ${quoteVisibleExact(getWebappsDirectory())}. Access: copies files outside the workspace sandbox`,
    execute: (args, context) => requireSlots(context).createWebapp(args),
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) => `Created the ${result.name} webapp at version v1.`,
    locks: ["webapps"],
});
