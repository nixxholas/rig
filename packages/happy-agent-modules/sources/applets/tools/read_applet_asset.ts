import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    appletAssetReadInputSchema,
    appletAssetResultSchema,
    type AppletAssetReadInput,
} from "../Applet.js";
import type { AppletModule } from "../AppletModule.js";

/** Read one bounded file from an installed applet version. */
export function readAppletAssetTool(applets: AppletModule, _agentId: string) {
    return defineAgentTool({
        name: "read_applet_asset",
        description:
            "Read one file from an installed applet version. Content is bounded and may be returned as UTF-8 or base64.",
        parameters: appletAssetReadInputSchema,
        returnType: appletAssetResultSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: AppletAssetReadInput) => await applets.readAsset(ctx, input),
        toLLM: (asset) => [
            {
                type: "text",
                text: applets.formatAssetForModel(asset ?? undefined),
            },
        ],
    });
}
