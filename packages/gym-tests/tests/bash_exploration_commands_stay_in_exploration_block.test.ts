import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("Bash exploration command rendering", () => {
    it("keeps an exploration command in the Explored block after it finishes", async () => {
        const gym = await createGym({
            environment: { ANTHROPIC_API_KEY: "claude-test-key" },
            files: {
                "src/example.ts": "export const needle = 42;\n",
            },
            inference: [
                {
                    content: [
                        {
                            arguments: {
                                command: "sed -n '1,20p' src/example.ts",
                            },
                            id: "explore-source",
                            name: "Bash",
                            type: "toolCall",
                        },
                    ],
                },
                { content: [{ text: "Inspection complete.", type: "text" }] },
            ],
            modelId: "anthropic/sonnet-5",
            providerId: "claude",
            providerOverrides: ["claude"],
            rows: 40,
        });
        running.add(gym);

        gym.terminal.type("Inspect the source tree.");
        gym.terminal.press("enter");

        const completed = await gym.terminal.waitForText("Inspection complete.", 30_000);
        expect(completed.text).toContain("• Explored");
        expect(completed.text).toContain("Read example.ts");
        expect(completed.text).not.toContain("• Ran sed");
        expect(completed.text).not.toContain("export const needle = 42");
    }, 120_000);
});
