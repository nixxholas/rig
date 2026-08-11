import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("agent requests a secret through a client attachment", () => {
    it("offers the common tool and keeps secret values out of the conversation", async () => {
        const gym = await createGym({
            inference(request, callIndex) {
                const toolNames = request.context.tools?.map((tool) => tool.name) ?? [];
                expect(toolNames).toContain("request_secret");
                if (callIndex === 0) {
                    return {
                        content: [
                            {
                                arguments: {
                                    description: "Credentials used to publish releases.",
                                    environment_variables: ["NPM_TOKEN"],
                                    instructions:
                                        "Create an npm access token with permission to publish this package.",
                                    operation: "create",
                                    secret_id: "npm-publishing",
                                },
                                id: "request-secret-1",
                                name: "request_secret",
                                type: "toolCall",
                            },
                        ],
                    };
                }

                const result = request.context.messages.at(-1);
                expect(result).toMatchObject({
                    isError: false,
                    role: "toolResult",
                    toolName: "request_secret",
                });
                expect(JSON.stringify(result)).toContain("npm-publishing");
                expect(JSON.stringify(result)).not.toContain("secret value");
                return {
                    content: [
                        {
                            text: "Open the secret request to add the publishing credential.",
                            type: "text",
                        },
                    ],
                };
            },
        });
        running.add(gym);

        gym.terminal.type("Prepare the publishing credential request.");
        gym.terminal.press("enter");

        const screen = await gym.terminal.waitForText(
            "Open the secret request to add the publishing credential.",
        );
        expect(screen.text).toContain("Request secret");
    }, 30_000);
});
