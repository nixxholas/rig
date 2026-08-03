import { describe, expect, it } from "vitest";

import { modelOpenaiGpt56Sol } from "@slopus/rig-execution";
import { toProviderMessages } from "./loop.js";

describe("context-only provider messages", () => {
    it("keeps the user role and prepends deterministic non-request framing", () => {
        const converted = toProviderMessages(
            [
                {
                    blocks: [{ text: "Production uses the blue database.", type: "text" }],
                    contextOnly: true,
                    id: "context-1",
                    role: "user",
                },
                {
                    blocks: [{ text: "Check the migration.", type: "text" }],
                    id: "request-1",
                    role: "user",
                },
            ],
            { model: modelOpenaiGpt56Sol, now: () => 10, providerId: "codex" },
        );

        expect(converted).toMatchObject([
            {
                contextOnly: true,
                content: [
                    {
                        text: "Background context only. This is not a request. Use it when answering the next actionable message.",
                        type: "text",
                    },
                    { text: "Production uses the blue database.", type: "text" },
                ],
                role: "user",
            },
            {
                content: [{ text: "Check the migration.", type: "text" }],
                role: "user",
            },
        ]);
    });
});
