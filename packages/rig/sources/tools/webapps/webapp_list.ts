import { Type } from "@sinclair/typebox";

import { defineTool } from "../../agent/types.js";
import { webappSchema, type Webapp } from "../../protocol/WebappProtocol.js";
import { requireSlots } from "../slots/requireSlots.js";

export const webappListTool = defineTool({
    name: "webapp_list",
    label: "List webapps",
    description:
        "List every webapp with its description, purpose, author session, current version, and full version history.",
    arguments: Type.Object({}, { additionalProperties: false }),
    returnType: Type.Object({ webapps: Type.Array(webappSchema) }, { additionalProperties: false }),
    execute: (_args, context): { webapps: Webapp[] } => ({
        webapps: [...requireSlots(context).listWebapps()],
    }),
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) =>
        result.webapps.length === 0
            ? "No webapps exist."
            : `Found ${String(result.webapps.length)} ${result.webapps.length === 1 ? "webapp" : "webapps"}.`,
    shouldReviewInAutoMode: () => false,
    locks: [],
});
