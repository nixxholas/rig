import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("global security policy reaches the Auto reviewer and follows edits", () => {
    it("uses the latest global SECURITY.md for each permission review", async () => {
        const firstPolicy = "FIRST SECURITY POLICY: allow this local verification command.";
        const secondPolicy = "SECOND SECURITY POLICY: allow this local verification command.";
        const gym = await createGym({
            homeFiles: { "happy/config/SECURITY.md": `${firstPolicy}\n` },
            inference(request, callIndex) {
                const systemPrompt = request.context.systemPrompt ?? "";
                if (systemPrompt.includes("judging one planned coding-agent action")) {
                    return {
                        content: [
                            {
                                text: JSON.stringify({
                                    outcome: "allow",
                                    risk_level: "low",
                                    user_authorization: "high",
                                    rationale: "The configured security policy allows this action.",
                                }),
                                type: "text",
                            },
                        ],
                    };
                }

                if (callIndex === 0 || callIndex === 3) {
                    return {
                        content: [
                            {
                                arguments: {
                                    cmd:
                                        callIndex === 0
                                            ? "printf 'first\\n' > first.txt"
                                            : "printf 'second\\n' > second.txt",
                                    justification: "Run the requested local verification command.",
                                    sandbox_permissions: "require_escalated",
                                    workdir: "/workspace",
                                },
                                id: callIndex === 0 ? "first-command" : "second-command",
                                name: "exec_command",
                                type: "toolCall",
                            },
                        ],
                    };
                }

                return {
                    content: [
                        {
                            text:
                                callIndex === 2
                                    ? "FIRST_REVIEW_COMPLETE"
                                    : "SECOND_REVIEW_COMPLETE",
                            type: "text",
                        },
                    ],
                };
            },
            permissionMode: "auto",
        });
        running.add(gym);

        gym.terminal.type("Run the first local verification command.");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("FIRST_REVIEW_COMPLETE", 30_000);

        const firstRequests = agentRequests(gym);
        const firstReview = reviewRequests(firstRequests)[0];
        expect(firstReview?.context.systemPrompt).toContain(firstPolicy);
        expect(firstReview?.context.systemPrompt).toContain(
            "Organization: default generic tenant.",
        );
        expect(JSON.stringify(firstRequests[0]?.context.messages)).not.toContain(firstPolicy);
        await expect(gym.readFile("first.txt")).resolves.toBe("first\n");

        await gym.runInContainer("node", [
            "-e",
            `require("node:fs").writeFileSync("/home/rig/happy/config/SECURITY.md", ${JSON.stringify(`${secondPolicy}\n`)})`,
        ]);

        gym.terminal.type("Run the second local verification command.");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("SECOND_REVIEW_COMPLETE", 30_000);

        const requests = agentRequests(gym);
        const secondReview = reviewRequests(requests)[1];
        expect(secondReview?.context.systemPrompt).toContain(secondPolicy);
        expect(secondReview?.context.systemPrompt).toContain(
            "Organization: default generic tenant.",
        );
        expect(secondReview?.context.systemPrompt).not.toContain(firstPolicy);
        expect(
            requests
                .filter((request) => !isReviewRequest(request))
                .map((request) => JSON.stringify(request.context.messages))
                .join("\n"),
        ).not.toContain(secondPolicy);
        await expect(gym.readFile("second.txt")).resolves.toBe("second\n");
    }, 120_000);
});

function agentRequests(gym: Gym) {
    return gym.inference.requests.filter(
        (request) => !request.options.sessionId?.endsWith(":title"),
    );
}

function isReviewRequest(request: ReturnType<typeof agentRequests>[number]): boolean {
    return (
        request.context.systemPrompt?.includes("judging one planned coding-agent action") === true
    );
}

function reviewRequests(requests: ReturnType<typeof agentRequests>) {
    return requests.filter(isReviewRequest);
}
