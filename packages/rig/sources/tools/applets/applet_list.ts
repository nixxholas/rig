import { Type } from "@sinclair/typebox";

import { defineTool } from "../../agent/types.js";
import { appletSchema, type Applet } from "../../protocol/AppletProtocol.js";
import { requireSlots } from "../slots/requireSlots.js";

export const appletListTool = defineTool({
    name: "applet_list",
    label: "List applets",
    description:
        "List every applet with its description, purpose, author session, current version, and full version history.",
    arguments: Type.Object({}, { additionalProperties: false }),
    returnType: Type.Object({ applets: Type.Array(appletSchema) }, { additionalProperties: false }),
    execute: async (_args, context): Promise<{ applets: Applet[] }> => ({
        applets: [...(await requireSlots(context).listApplets())],
    }),
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) =>
        result.applets.length === 0
            ? "No applets exist."
            : `Found ${String(result.applets.length)} ${result.applets.length === 1 ? "applet" : "applets"}.`,
    shouldReviewInAutoMode: () => false,
    locks: [],
});
