import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("Auto permission allow and deny decisions are enforced", () => {
    it("runs an automatically approved command and blocks a denied command", async () => {
        const allowedCommand = "printf 'approved by auto review\\n' > auto-approved.txt";
        const deniedCommand = "printf 'this must not run\\n' > auto-denied.txt";
        const gym = await createGym({
            cols: 96,
            inference(request, callIndex) {
                const systemPrompt = request.context.systemPrompt ?? "";
                const lastMessage = request.context.messages.at(-1);

                if (systemPrompt.includes("independent permission reviewer")) {
                    if (callIndex === 1) {
                        return {
                            content: [
                                {
                                    text: JSON.stringify({
                                        decision: "allow",
                                        risk: "low",
                                        user_authorization: "high",
                                        reason: "The user directly requested this local workspace check.",
                                    }),
                                    type: "text",
                                },
                            ],
                        };
                    }

                    return {
                        content: [
                            {
                                text: JSON.stringify({
                                    decision: "deny",
                                    risk: "high",
                                    user_authorization: "medium",
                                    reason: "This command needs explicit one-time approval.",
                                }),
                                type: "text",
                            },
                        ],
                    };
                }

                if (callIndex === 0) {
                    expect(messageText(lastMessage)).toContain("Run the safe local command");
                    return {
                        content: [
                            {
                                arguments: {
                                    cmd: allowedCommand,
                                    justification:
                                        "Run the explicitly requested command outside the sandbox.",
                                    sandbox_permissions: "require_escalated",
                                    workdir: "/workspace",
                                },
                                id: "auto-approved-command",
                                name: "exec_command",
                                type: "toolCall",
                            },
                        ],
                    };
                }

                if (callIndex === 2) {
                    expect(lastMessage).toMatchObject({
                        isError: false,
                        role: "toolResult",
                        toolName: "exec_command",
                    });
                    return {
                        content: [{ text: "AUTO_APPROVAL_FINISHED", type: "text" }],
                    };
                }

                if (callIndex === 3) {
                    expect(messageText(lastMessage)).toContain("Try the second command");
                    return {
                        content: [
                            {
                                arguments: {
                                    cmd: deniedCommand,
                                    justification: "Attempt the second requested proof file.",
                                    sandbox_permissions: "require_escalated",
                                    workdir: "/workspace",
                                },
                                id: "auto-denied-command",
                                name: "exec_command",
                                type: "toolCall",
                            },
                        ],
                    };
                }

                expect(callIndex).toBe(5);
                expect(lastMessage).toMatchObject({
                    isError: true,
                    role: "toolResult",
                    toolName: "exec_command",
                });
                expect(messageText(lastMessage)).toContain(
                    "Automatic permission review refused running",
                );
                expect(messageText(lastMessage)).toContain(
                    "Reason: This command needs explicit one-time approval.",
                );
                return {
                    content: [{ text: "AUTO_DENIAL_FINISHED", type: "text" }],
                };
            },
            rows: 28,
        });
        running.add(gym);
        const startup = await gym.terminal.snapshot();

        gym.terminal.type("/permissions");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("Choose Permissions");
        gym.terminal.press("up");
        gym.terminal.press("up");
        gym.terminal.press("up");
        gym.terminal.press("enter");

        const autoSelected = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("Permissions changed to Auto.") &&
                snapshot.text.includes("Ask Rig to do anything") &&
                snapshot.scroll.atBottom,
            "Auto permissions selection",
        );
        assertStableViewport(autoSelected, startup);

        gym.terminal.type("Run the safe local command through Auto permissions.");
        gym.terminal.press("enter");
        const automaticallyApproved = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("AUTO_APPROVAL_FINISHED") &&
                snapshot.text.includes("Ask Rig to do anything") &&
                snapshot.scroll.atBottom,
            "automatically approved action and completed turn",
            30_000,
        );
        expect(automaticallyApproved.rows.some((row) => row.includes("• Auto permission"))).toBe(
            false,
        );
        expect(automaticallyApproved.text).not.toContain("Approved automatically");
        expect(automaticallyApproved.text).not.toContain("Risk: Low");
        expect(automaticallyApproved.text).not.toContain("User authorization: High");
        expect(automaticallyApproved.text).not.toContain(
            "The user directly requested this local workspace check.",
        );
        expect(automaticallyApproved.text).not.toContain("user_authorization");
        assertStableViewport(automaticallyApproved, startup);
        await expect(gym.readFile("auto-approved.txt")).resolves.toBe("approved by auto review\n");

        gym.terminal.type("Try the second command only if Auto permits it.");
        gym.terminal.press("enter");
        const denied = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("AUTO_DENIAL_FINISHED") &&
                snapshot.text.includes("Ask Rig to do anything") &&
                snapshot.scroll.atBottom,
            "denied action result and recovered composer",
            30_000,
        );
        expect(denied.text).toContain("Automatic permission review refused running");
        expect(normalizeWhitespace(denied.text)).toContain(
            "This command needs explicit one-time approval.",
        );
        expect(normalizeWhitespace(denied.text)).toContain(
            "Refused: This command needs explicit one-time approval. Risk: High. User authorization: Medium.",
        );
        expect(denied.text).not.toContain("Allow once");
        expect(denied.text).not.toContain("Waiting for approval");
        expect(denied.text).not.toContain("Awaiting approval");
        expect(denied.text).not.toContain("auto-denied-command");
        expect(denied.text).not.toContain("�");
        expect(denied.cursor.x).toBeLessThan(96);
        expect(denied.cursor.y).toBeLessThan(28);
        assertStableViewport(denied, startup);
        await expect(gym.readFile("auto-denied.txt")).rejects.toMatchObject({ code: "ENOENT" });

        const agentRequests = gym.inference.requests.filter(
            (request) => !request.options.sessionId?.endsWith(":title"),
        );
        expect(agentRequests).toHaveLength(6);
        expect(
            agentRequests.filter((request) =>
                request.context.systemPrompt?.includes("independent permission reviewer"),
            ),
        ).toHaveLength(2);
        const reviewRequests = agentRequests.filter((request) =>
            request.context.systemPrompt?.includes("independent permission reviewer"),
        );
        expect(messageText(reviewRequests[0]?.context.messages.at(-1))).toContain(
            "auto-approved.txt",
        );
        expect(messageText(reviewRequests[1]?.context.messages.at(-1))).toContain(
            "auto-denied.txt",
        );
    }, 120_000);
});

function messageText(message: { content: unknown } | undefined): string {
    if (typeof message?.content === "string") return message.content;
    if (!Array.isArray(message?.content)) return "";
    return message.content
        .filter(
            (block): block is { text: string; type: "text" } =>
                typeof block === "object" &&
                block !== null &&
                "type" in block &&
                block.type === "text" &&
                "text" in block &&
                typeof block.text === "string",
        )
        .map((block) => block.text)
        .join("");
}

function normalizeWhitespace(value: string): string {
    return value.replace(/\s+/gu, " ");
}

function assertStableViewport(
    snapshot: Awaited<ReturnType<Gym["terminal"]["snapshot"]>>,
    startup: Awaited<ReturnType<Gym["terminal"]["snapshot"]>>,
): void {
    expect(snapshot.rows).toHaveLength(28);
    expect(snapshot.scroll.visibleRows).toBe(28);
    expect(snapshot.scroll.atBottom).toBe(true);
    expect(snapshot.scroll.bottomDepartureCount).toBe(startup.scroll.bottomDepartureCount);
    expect(snapshot.scroll.topArrivalCount).toBe(startup.scroll.topArrivalCount);
    expect(snapshot.text).toContain("gym off");
    expect(snapshot.text).toContain("/workspace");
}
