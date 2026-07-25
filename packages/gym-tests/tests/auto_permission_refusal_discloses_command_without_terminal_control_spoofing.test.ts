import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("Auto refusal discloses commands without terminal-control spoofing", () => {
    it("keeps the terminal identity and full command visible while enforcing denial", async () => {
        const titleControl = "\x1b]0;CORRUPTED_PERMISSION_TITLE\x07";
        const safePadding = "x".repeat(150);
        const command = `printf 'must not run\\n' > spoofed-command.txt; # ${titleControl}${safePadding} VISIBLE_COMMAND_SUFFIX`;
        const visibleCommand = command
            .replaceAll("\\", "\\\\")
            .replaceAll("\x1b", "\\u{001b}")
            .replaceAll("\x07", "\\u{0007}");
        const gym = await createGym({
            cols: 96,
            inference(request, callIndex) {
                const systemPrompt = request.context.systemPrompt ?? "";
                const lastMessage = request.context.messages.at(-1);

                if (systemPrompt.includes("independent permission reviewer")) {
                    expect(callIndex).toBe(1);
                    return {
                        content: [
                            {
                                text: JSON.stringify({
                                    decision: "deny",
                                    risk: "high",
                                    user_authorization: "low",
                                    reason: "The proposed command is not authorized.",
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
                                    cmd: command,
                                    justification: "Demonstrate a safely denied command.",
                                    sandbox_permissions: "require_escalated",
                                    workdir: "/workspace",
                                },
                                id: "spoofed-permission-command",
                                name: "exec_command",
                                type: "toolCall",
                            },
                        ],
                    };
                }

                if (callIndex === 2) {
                    expect(lastMessage).toMatchObject({
                        isError: true,
                        role: "toolResult",
                        toolName: "exec_command",
                    });
                    const refusal = messageText(lastMessage);
                    expect(withoutWhitespace(refusal)).toContain(withoutWhitespace(visibleCommand));
                    expect(refusal).toContain("\\u{001b}]0;CORRUPTED_PERMISSION_TITLE\\u{0007}");
                    expect(refusal).toContain('Working directory: "/workspace"');
                    expect(refusal).toContain("Access: unrestricted filesystem and network access");
                    expect(refusal).toContain("Reason: The proposed command is not authorized.");
                    return {
                        content: [{ text: "SPOOFED_COMMAND_DENIED", type: "text" }],
                    };
                }

                expect(callIndex).toBe(3);
                return {
                    content: [{ text: "SPOOFING_FOLLOW_UP_COMPLETE", type: "text" }],
                };
            },
            rows: 32,
        });
        running.add(gym);
        const baseline = (await gym.terminal.snapshot()).scroll;

        gym.terminal.type("/permissions");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("Choose Permissions");
        gym.terminal.press("up");
        gym.terminal.press("up");
        gym.terminal.press("up");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("Permissions changed to Auto.");

        gym.terminal.type("Review this command and refuse it if it is not authorized.");
        gym.terminal.press("enter");
        const denied = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("SPOOFED_COMMAND_DENIED") &&
                snapshot.text.includes("Ask Rig to do anything") &&
                snapshot.scroll.atBottom,
            "the denied command and recovered composer",
            30_000,
        );
        const normalizedDenied = normalizeWhitespace(denied.text);
        expect(normalizedDenied).toContain("Refused: The proposed command is not authorized.");
        expect(normalizedDenied).toContain("Risk: High. User authorization: Low.");
        expect(denied.text).not.toContain("Allow once");
        expect(denied.text).not.toContain("Waiting for approval");
        expect(denied.text).not.toContain("spoofed-permission-command");
        expect(denied.text).not.toContain("\x1b");
        expect(denied.title).toContain("Rig");
        expect(denied.title).not.toContain("CORRUPTED_PERMISSION_TITLE");
        await expect(gym.readFile("spoofed-command.txt")).rejects.toMatchObject({ code: "ENOENT" });
        assertTerminalHealth(denied, baseline);

        gym.terminal.type("Confirm normal rendering after the denied command.");
        gym.terminal.press("enter");
        const followUp = await gym.terminal.waitForText("SPOOFING_FOLLOW_UP_COMPLETE", 30_000);
        expect(followUp.text).toContain("Ask Rig to do anything");
        expect(followUp.title).toContain("Rig");
        expect(followUp.text).not.toContain("�");
        assertTerminalHealth(followUp, baseline);
    }, 120_000);
});

function normalizeWhitespace(value: string): string {
    return value.replace(/\s+/gu, " ");
}

function withoutWhitespace(value: string): string {
    return value.replace(/\s+/gu, "");
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

function assertTerminalHealth(
    snapshot: Awaited<ReturnType<Gym["terminal"]["snapshot"]>>,
    baseline: Awaited<ReturnType<Gym["terminal"]["snapshot"]>>["scroll"],
): void {
    expect(snapshot.rows).toHaveLength(32);
    expect(snapshot.scroll.visibleRows).toBe(32);
    expect(snapshot.scroll.atBottom).toBe(true);
    expect(snapshot.scroll.bottomDepartureCount).toBe(baseline.bottomDepartureCount);
    expect(snapshot.scroll.topArrivalCount).toBe(baseline.topArrivalCount);
    expect(snapshot.text).toContain("gym off");
    expect(snapshot.text).toContain("/workspace");
    expect(snapshot.text).not.toContain("�");
    expect(snapshot.cursor.x).toBeLessThan(96);
    expect(snapshot.cursor.y).toBeLessThan(32);
}
