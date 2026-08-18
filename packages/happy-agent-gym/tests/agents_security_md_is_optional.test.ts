import { afterEach, describe, expect, it } from "vitest";

import { createAgentGym, type AgentGym } from "../sources/index.js";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

/**
 * AGENTS_SECURITY.md is read on every turn but almost never exists. The emulated filesystem's
 * missing-file error must still be recognized as "there is no such file" rather than an internal
 * failure, or every ordinary project without one would fail to start a turn at all.
 */
describe("AGENTS_SECURITY.md is optional", () => {
    it("does not fail the turn when the project has no AGENTS_SECURITY.md", async () => {
        const gym = await createAgentGym({
            files: { "AGENTS.md": "Use the project conventions.\n" },
            inference: [{ content: [{ text: "Done.", type: "text" }] }],
        });
        running.add(gym);

        await gym.send("Say hello.");

        expect(gym.inference.requests[0]?.instructions).toContain("Use the project conventions.");
        expect(gym.inference.requests[0]?.instructions).not.toContain("SECURITY_RULES");
        expect(gym.inference.unscripted).toEqual([]);
        expect(gym.errors).toEqual([]);
    });

    it("includes AGENTS_SECURITY.md rules once the file exists", async () => {
        const gym = await createAgentGym({
            files: { "AGENTS_SECURITY.md": "Never expose credentials.\n" },
            inference: [{ content: [{ text: "Done.", type: "text" }] }],
        });
        running.add(gym);

        await gym.send("Say hello.");

        expect(gym.inference.requests[0]?.instructions).toContain("SECURITY_RULES");
        expect(gym.inference.requests[0]?.instructions).toContain("Never expose credentials.");
        expect(gym.errors).toEqual([]);
    });
});
