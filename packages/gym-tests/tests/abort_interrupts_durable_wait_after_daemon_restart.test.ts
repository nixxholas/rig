import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("aborting a durable wait after daemon restart", () => {
    it("stops the restored run instead of leaving it waiting", async () => {
        const gym = await createGym({
            entrypoint: [
                "bash",
                "-lc",
                [
                    "node /app/packages/rig/dist/main.js",
                    "node /app/packages/rig/dist/main.js daemon start",
                    "exec node /app/packages/rig/dist/main.js resume --last",
                ].join("; "),
            ],
            environment: {
                NODE_NO_WARNINGS: "1",
                NODE_OPTIONS: "--experimental-transform-types --import=/app/rig-source-hook.mjs",
            },
            inference: [
                {
                    content: [
                        {
                            arguments: { hours: 12 },
                            id: "restart-abort-wait",
                            name: "wait",
                            type: "toolCall",
                        },
                    ],
                },
            ],
            mode: "docker",
        });
        running.add(gym);

        submit(gym, "Wait until I stop this run.");
        await gym.terminal.waitForText("Waiting until", 30_000);

        await gym.runInContainer("node", ["/app/packages/rig/dist/main.js", "daemon", "stop"]);
        await gym.runInContainer(
            "sh",
            [
                "-c",
                "while node /app/packages/rig/dist/main.js daemon status | grep -q 'Daemon is running'; do sleep 0.05; done",
            ],
            { timeoutMs: 30_000 },
        );
        await gym.runInContainer("node", ["/app/packages/rig/dist/main.js", "daemon", "start"]);
        await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("Resumed") &&
                snapshot.text.includes("Running 1 tool") &&
                snapshot.text.includes("esc to interrupt"),
            "the restored durable wait",
            30_000,
        );

        gym.terminal.press("escape");
        const aborted = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("Ask Rig to do anything") &&
                !snapshot.text.includes("Running 1 tool") &&
                !snapshot.text.includes("esc to interrupt"),
            "the restored durable wait to stop",
            30_000,
        );
        expect(aborted.text).not.toContain("Waiting until");
        expect(
            gym.inference.requests.filter(
                (request) => !request.options.sessionId?.endsWith(":title"),
            ),
        ).toHaveLength(1);
    }, 120_000);
});

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}
