import { afterEach, describe, expect, it } from "vitest";

import { createAgentGym, type AgentGym, type GymBlock, type GymTurn } from "../sources/index.js";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

/** One shell command, so that the mode in force is the only thing that differs between scenarios. */
function runs(command: string): GymTurn {
    const call: GymBlock = { arguments: { cmd: command }, name: "exec_command", type: "tool_call" };
    return { content: [call] };
}

/** Every permission decision the daemon journaled, in order. */
async function permissionEvents(gym: AgentGym): Promise<readonly Record<string, unknown>[]> {
    const events = await gym.events();
    return events
        .filter((event) => event.type === "permission.event")
        .map((event) => event.payload as Record<string, unknown>);
}

describe("the mode an agent runs in decides what its command may change", () => {
    it("refuses the write in read only, and the file still says what it did before", async () => {
        const gym = await createAgentGym({
            files: { "notes.md": "original\n" },
            inference: [
                runs("echo changed > notes.md && echo written"),
                { content: [{ text: "I could not change the notes.", type: "text" }] },
            ],
        });
        running.add(gym);

        await gym.send("Change the notes.", { permissionMode: "read_only" });

        // The write never happened, and the machine is the proof rather than the model's summary.
        await expect(gym.readFile("notes.md")).resolves.toBe("original\n");

        const results = gym.inference.toolResults();
        expect(results).toHaveLength(1);
        expect(results[0]?.text).toContain("File changes are disabled in read-only mode.");
        expect(results[0]?.text).not.toContain("written");

        // The model was told the rules it was working under before it ever called the tool.
        expect(gym.inference.requests[0]?.instructions).toContain(
            "You are working in Read only mode",
        );

        expect(await permissionEvents(gym)).toEqual([
            expect.objectContaining({
                mode: "read_only",
                previousMode: "auto",
                type: "permission_mode_changed",
            }),
        ]);

        // What a client sees: the chat itself reports the mode the turn ran in.
        const events = await gym.sessionEvents();
        expect(events).toContainEqual(
            expect.objectContaining({
                data: expect.objectContaining({ permissionMode: "read_only" }),
                type: "permission_mode_changed",
            }),
        );
        expect(await gym.getSession()).toMatchObject({ permissionMode: "read_only" });
        expect(gym.inference.unscripted).toEqual([]);
        expect(gym.errors).toEqual([]);
    });

    it("lets the same write land in workspace write, while the project's own rules stay protected", async () => {
        const gym = await createAgentGym({
            files: { "AGENTS.md": "the project rules\n", "notes.md": "original\n" },
            inference: [
                runs("echo changed > notes.md && echo written"),
                runs("echo rewritten > AGENTS.md && echo written"),
                { content: [{ text: "The notes changed; the rules did not.", type: "text" }] },
            ],
        });
        running.add(gym);

        await gym.send("Change the notes, then the rules.", { permissionMode: "workspace_write" });

        await expect(gym.readFile("notes.md")).resolves.toBe("changed\n");
        // Workspace write is not a licence to edit the file that tells the agent what to do.
        await expect(gym.readFile("AGENTS.md")).resolves.toBe("the project rules\n");

        const results = gym.inference.toolResults();
        expect(results[0]?.text).toContain("written");
        expect(results[1]?.text).toContain("Permission boundary blocks modifying the denied path");
        expect(results[1]?.text).toContain("AGENTS.md");

        // Neither command was put to a reviewer: outside Auto nothing is reviewed at all.
        expect(await permissionEvents(gym)).toEqual([
            expect.objectContaining({ mode: "workspace_write", type: "permission_mode_changed" }),
        ]);
        expect(gym.inference.unscripted).toEqual([]);
        expect(gym.errors).toEqual([]);
    });

    it("changes even a protected file in full access, and asks nobody first", async () => {
        const gym = await createAgentGym({
            files: { "AGENTS.md": "the project rules\n" },
            inference: [
                runs("echo rewritten > AGENTS.md && echo written"),
                { content: [{ text: "I rewrote the rules.", type: "text" }] },
            ],
        });
        running.add(gym);

        await gym.send("Rewrite the project rules.", { permissionMode: "full_access" });

        await expect(gym.readFile("AGENTS.md")).resolves.toBe("rewritten\n");
        expect(gym.inference.toolResults()[0]?.text).toContain("written");

        // Full access removes the boundary, so no review was requested and none was recorded.
        const asked = gym.inference.requests.filter((request) =>
            JSON.stringify(request.messages).includes("<proposed_action>"),
        );
        expect(asked).toEqual([]);
        expect(await permissionEvents(gym)).toEqual([
            expect.objectContaining({ mode: "full_access", type: "permission_mode_changed" }),
        ]);
        expect(gym.inference.unscripted).toEqual([]);
        expect(gym.errors).toEqual([]);
    });
});
