import { describe, expect, it } from "vitest";

import { hasResponseContentBegun } from "./hasResponseContentBegun.js";
import type { ProviderAssistantMessageEvent } from "@slopus/rig-execution";

describe("hasResponseContentBegun", () => {
    it.each([
        "start",
        "block_start",
        "block_stop",
        "block_reset",
        "retrying",
        "done",
        "error",
        "text_start",
        "thinking_start",
    ] satisfies ProviderAssistantMessageEvent["type"][])(
        "ignores the structural %s event",
        (type) => {
            expect(hasResponseContentBegun({ type } as ProviderAssistantMessageEvent)).toBe(false);
        },
    );

    it.each(["text_delta", "thinking_delta"] as const)(
        "requires payload bytes in a %s event",
        (type) => {
            expect(
                hasResponseContentBegun({ type, delta: "" } as ProviderAssistantMessageEvent),
            ).toBe(false);
            expect(
                hasResponseContentBegun({
                    type,
                    delta: "content",
                } as ProviderAssistantMessageEvent),
            ).toBe(true);
        },
    );

    it("treats a tool-call start as response content", () => {
        expect(
            hasResponseContentBegun({
                type: "toolcall_start",
            } as ProviderAssistantMessageEvent),
        ).toBe(true);
    });
});
