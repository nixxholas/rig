import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("account quota reported during inference", () => {
    it("shows the reported quota and answers the usage tool without asking the vendor again", async () => {
        const fiveHourResetsAt = Date.now() + 3 * 60 * 60 * 1_000;
        let accountRequests = 0;
        const toolResults: string[] = [];
        const gym = await createGym({
            cols: 80,
            environment: {
                ANTHROPIC_BASE_URL: "{{HTTP_PROXY_URL}}",
                CLAUDE_CODE_OAUTH_TOKEN: "claude-test-token",
                // Rig's own local daemon traffic must not take the account proxy.
                NO_PROXY: "localhost",
            },
            httpProxy: {
                handler(request) {
                    const path = new URL(request.url).pathname;
                    if (path.startsWith("/api/oauth") || path === "/v1/messages") {
                        accountRequests += 1;
                        // An inference-only token can read no account metadata,
                        // so the reported quota can only come from a real run.
                        return { response: { body: "{}", status: 403 } };
                    }
                    return { response: { body: "Unexpected account request", status: 404 } };
                },
            },
            inference(request, callIndex) {
                if (callIndex === 0) {
                    return {
                        accountUsage: accountUsage(42, fiveHourResetsAt),
                        content: [{ text: "QUOTA_REPORTED", type: "text" }],
                    };
                }
                if (callIndex === 1) {
                    return {
                        content: [
                            {
                                arguments: {},
                                id: "usage-call",
                                name: "get_provider_usage",
                                type: "toolCall",
                            },
                        ],
                    };
                }
                for (const message of request.context.messages) {
                    if (message.role !== "toolResult") continue;
                    for (const block of message.content) {
                        if (block.type === "text") toolResults.push(block.text);
                    }
                }
                return { content: [{ text: "QUOTA_TOOL_ANSWERED", type: "text" }] };
            },
            providerId: "claude",
            providerOverrides: ["claude"],
            rows: 30,
        });
        running.add(gym);

        submit(gym, "Report the account quota.");
        await gym.terminal.waitForText("QUOTA_REPORTED", 30_000);
        const requestsAfterRun = accountRequests;

        submit(gym, "/usage");
        const usage = await gym.terminal.waitUntil(
            (screen) => screen.text.includes("5-hour: 58% left"),
            "the quota the provider reported while it answered",
            30_000,
        );
        expect(usage.text).toContain("Claude");
        // The reading rode along with inference, so nothing was asked of the vendor.
        expect(accountRequests).toBe(requestsAfterRun);

        submit(gym, "Read the account usage with the tool.");
        await gym.terminal.waitForText("QUOTA_TOOL_ANSWERED", 30_000);
        expect(toolResults.join("\n")).toContain("42%");
        expect(accountRequests).toBe(requestsAfterRun);
    }, 120_000);
});

function accountUsage(usedPercent: number, resetsAt: number) {
    return {
        providerId: "claude",
        vendor: "claude" as const,
        capturedAt: Date.now(),
        planName: "Max",
        exhausted: false,
        windows: {
            fiveHour: {
                durationMs: 5 * 60 * 60 * 1_000,
                resetsAt,
                startsAt: null,
                usedPercent,
            },
            weekly: null,
            monthly: null,
        },
        credits: null,
    };
}

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}
