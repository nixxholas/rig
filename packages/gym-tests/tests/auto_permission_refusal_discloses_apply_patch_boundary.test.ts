import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("apply_patch Auto refusal disclosure", () => {
    it("reports affected paths and the unrestricted filesystem boundary while denying", async () => {
        const path = "/home/rig/apply-patch-disclosure.txt";
        const workspaceMarker = "/workspace/apply-patch-should-not-run.txt";
        const gym = await createGym({
            cols: 112,
            inference(request, callIndex) {
                const systemPrompt = request.context.systemPrompt ?? "";
                if (systemPrompt.includes("independent permission reviewer")) {
                    expect(callIndex).toBe(1);
                    return {
                        content: [
                            {
                                text: JSON.stringify({
                                    decision: "deny",
                                    reason: "This patch writes outside the workspace.",
                                    risk: "high",
                                    user_authorization: "low",
                                }),
                                type: "text",
                            },
                        ],
                    };
                }

                if (callIndex === 0) {
                    return {
                        content: [
                            {
                                arguments: {
                                    patch: [
                                        "*** Begin Patch",
                                        `*** Add File: ${path}`,
                                        "+must not be written",
                                        `*** Add File: ${workspaceMarker}`,
                                        "+must not be written either",
                                        "*** End Patch",
                                    ].join("\n"),
                                },
                                id: "apply-patch-disclosure-call",
                                name: "apply_patch",
                                type: "toolCall",
                            },
                        ],
                    };
                }

                expect(callIndex).toBe(2);
                const result = request.context.messages.at(-1);
                expect(result).toMatchObject({
                    isError: true,
                    role: "toolResult",
                    toolName: "apply_patch",
                });
                const refusal = messageText(result);
                expect(refusal).toContain(path);
                expect(refusal).toContain(workspaceMarker);
                expect(refusal).toContain('Working directory: "/workspace"');
                expect(refusal).toContain(
                    "Access: unrestricted filesystem access outside the workspace sandbox",
                );
                expect(refusal).toContain("Reason: This patch writes outside the workspace.");
                return { content: [{ text: "PATCH_DISCLOSURE_DENIED", type: "text" }] };
            },
            rows: 36,
        });
        running.add(gym);

        submit(gym, "/permissions");
        await gym.terminal.waitForText("Choose Permissions");
        gym.terminal.press("up");
        gym.terminal.press("up");
        gym.terminal.press("up");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("Permissions changed to Auto.");

        submit(gym, "Review the proposed patch outside the workspace.");
        const denied = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("PATCH_DISCLOSURE_DENIED") &&
                snapshot.text.includes("Ask Rig to do anything") &&
                snapshot.scroll.atBottom,
            "the refused apply_patch action and recovered composer",
            30_000,
        );
        const normalized = denied.text.replace(/\s+/gu, " ");
        expect(normalized).toContain("Refused: This patch writes outside the workspace.");
        expect(normalized).toContain("Risk: High. User authorization: Low.");
        expect(denied.text).not.toContain("Allow once");
        expect(denied.text).not.toContain("Waiting for approval");
        await expect(gym.readFile("apply-patch-should-not-run.txt")).rejects.toMatchObject({
            code: "ENOENT",
        });
    }, 120_000);
});

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}

function messageText(message: { content: unknown } | undefined): string {
    if (typeof message?.content === "string") return message.content;
    if (!Array.isArray(message?.content)) return "";
    return message.content
        .filter(
            (block): block is { text: string } =>
                typeof block === "object" &&
                block !== null &&
                "text" in block &&
                typeof block.text === "string",
        )
        .map((block) => block.text)
        .join("\n");
}
