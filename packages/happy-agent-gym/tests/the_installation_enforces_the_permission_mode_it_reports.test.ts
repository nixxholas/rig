import { afterEach, describe, expect, it } from "vitest";

import { createAgentGym, type AgentGym } from "../sources/index.js";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

/** A turn that tries to write a file, then reports whatever the machine said back. */
const writesAFile = [
    {
        content: [
            {
                arguments: { cmd: "echo written > written.md" },
                callId: "write-1",
                name: "exec_command",
                type: "tool_call" as const,
            },
        ],
    },
    { content: [{ text: "Finished.", type: "text" as const }] },
];

describe("the mode an installation was configured with", () => {
    it("refuses a write the configured read-only mode does not allow", async () => {
        const gym = await createAgentGym({
            files: { "notes.md": "original\n" },
            inference: writesAFile,
            permissionMode: "read_only",
        });
        running.add(gym);

        await gym.send("Write something down.");

        expect(await gym.exists("written.md")).toBe(false);
        const session = await gym.getSession();
        expect(session.permissionMode).toBe("read_only");
        // The refusal reached the model rather than the write silently doing nothing.
        expect(JSON.stringify(gym.inference.requests.at(-1))).toContain("read-only mode");
    });

    it("allows the same write when the installation was configured to allow it", async () => {
        const gym = await createAgentGym({
            inference: writesAFile,
            permissionMode: "workspace_write",
        });
        running.add(gym);

        await gym.send("Write something down.");

        expect(await gym.readFile("written.md")).toContain("written");
        expect((await gym.getSession()).permissionMode).toBe("workspace_write");
    });

    it("lets a single message run in a different mode without changing the session's own", async () => {
        const gym = await createAgentGym({
            inference: writesAFile,
            permissionMode: "read_only",
        });
        running.add(gym);

        await gym.send("Write something down.", { permissionMode: "workspace_write" });

        expect(await gym.readFile("written.md")).toContain("written");
        // A message that names a mode is how the mode changes, so the session now reports the mode
        // it is really running in rather than the one it started in.
        expect((await gym.getSession()).permissionMode).toBe("workspace_write");
    });
});
