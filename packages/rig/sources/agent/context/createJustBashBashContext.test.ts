import { Bash } from "just-bash";
import { describe, expect, it } from "vitest";

import { createJustBashBashContext } from "./createJustBashBashContext.js";
import { MAX_ACTIVE_BASH_SESSIONS } from "./bashSessionLimits.js";

describe("createJustBashBashContext", () => {
    it("evicts the oldest background command instead of refusing a new one", async () => {
        const aborts: (AbortSignal | undefined)[] = [];
        const exec = (_command: string, options?: { signal?: AbortSignal }) => {
            aborts.push(options?.signal);
            return new Promise<never>(() => {});
        };
        const context = createJustBashBashContext({ exec } as unknown as Bash, "/workspace");
        for (let index = 0; index < MAX_ACTIVE_BASH_SESSIONS; index += 1) {
            await context.startSession({ command: `pending-${String(index)}` });
        }

        // Running out of slots is ours to solve, not the model's: the oldest
        // command makes way and the new one starts.
        await expect(context.startSession({ command: "one-too-many" })).resolves.toBe(
            MAX_ACTIVE_BASH_SESSIONS + 1,
        );
        expect(aborts[0]?.aborted).toBe(true);
        // The evicted session stays readable: a model still holding its task id
        // deserves to learn what became of it.
        await expect(context.readSession(1)).resolves.toMatchObject({ command: "pending-0" });
    });

    it("retains a bounded set of completed background sessions", async () => {
        const context = createJustBashBashContext(new Bash({ cwd: "/workspace" }), "/workspace");

        for (let index = 1; index <= 65; index += 1) {
            const sessionId = await context.startSession({ command: `echo session-${index}` });
            await context.readSession(sessionId, { waitMs: 1_000 });
        }

        await expect(context.readSession(1)).resolves.toBeUndefined();
        await expect(context.readSession(65)).resolves.toMatchObject({
            status: "completed",
            stdout: "session-65\n",
        });
        expect(context.supportsSessionInput).toBe(false);
        await expect(context.writeSession(65, "input")).resolves.toBe(false);
    });
});
