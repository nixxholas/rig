import { describe, expect, it } from "vitest";

import { ClaudeToolBridge } from "@/vendors/claude/impl/ClaudeToolBridge.js";

describe("ClaudeToolBridge", () => {
    it("joins resolvers and answers arriving in either order", async () => {
        const bridge = new ClaudeToolBridge();
        bridge.register("first-bash", "Bash");
        bridge.register("second-bash", "Bash");
        const firstResult = bridge.execute("Bash");

        expect(
            bridge.resolveAll([
                {
                    role: "tool",
                    content: [{ type: "text" as const, text: "first complete" }],
                    callId: "first-bash",
                },
                {
                    role: "tool",
                    content: [{ type: "text" as const, text: "second complete" }],
                    callId: "second-bash",
                },
            ]),
        ).toBe(true);
        const secondResult = bridge.execute("Bash");

        await expect(firstResult).resolves.toMatchObject({
            content: [{ type: "text", text: "first complete" }],
        });
        await expect(secondResult).resolves.toMatchObject({
            content: [{ type: "text", text: "second complete" }],
        });
    });

    it("requires the complete batch and preserves the first answer for a call", async () => {
        const bridge = new ClaudeToolBridge();
        bridge.register("first", "Read");
        bridge.register("second", "Read");

        expect(
            bridge.resolveAll([
                {
                    role: "tool",
                    content: [{ type: "text" as const, text: "first answer" }],
                    callId: "first",
                },
                {
                    role: "tool",
                    content: [{ type: "text" as const, text: "unknown answer" }],
                    callId: "unknown",
                },
            ]),
        ).toBe(false);
        expect(
            bridge.resolve({
                role: "tool",
                content: [{ type: "text" as const, text: "replacement answer" }],
                callId: "first",
            }),
        ).toBe(false);

        await expect(bridge.execute("Read")).resolves.toMatchObject({
            content: [{ type: "text", text: "first answer" }],
        });
        const second = bridge.execute("Read");
        expect(
            bridge.resolve({
                role: "tool",
                content: [{ type: "text" as const, text: "second answer" }],
                callId: "second",
            }),
        ).toBe(true);
        await expect(second).resolves.toMatchObject({
            content: [{ type: "text", text: "second answer" }],
        });
    });
});
