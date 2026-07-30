import { describe, expect, it } from "vitest";

import { createPermissionContext } from "./createPermissionContext.js";

describe("createPermissionContext", () => {
    it("increments its revision only when the configured mode changes", () => {
        const context = createPermissionContext("workspace_write");

        expect(context.revision).toBe(0);
        context.setMode("workspace_write");
        expect(context.revision).toBe(0);
        context.setMode("read_only");
        expect(context.revision).toBe(1);
    });

    it("scopes temporary permission overrides to the current asynchronous call", async () => {
        const context = createPermissionContext("auto");
        let release: () => void = () => {};
        const wait = new Promise<void>((resolve) => {
            release = resolve;
        });
        let started: () => void = () => {};
        const hasStarted = new Promise<void>((resolve) => {
            started = resolve;
        });

        const elevated = context.runWithMode("full_access", async () => {
            expect(context.mode).toBe("full_access");
            started();
            await wait;
            expect(context.mode).toBe("full_access");
        });
        await hasStarted;

        expect(context.mode).toBe("auto");
        context.setMode("read_only");
        expect(context.mode).toBe("read_only");
        release();
        await elevated;
        expect(context.mode).toBe("read_only");
    });

    it("returns a rejected promise when a temporary action throws synchronously", async () => {
        const context = createPermissionContext("auto");
        const observedModes: string[] = [];
        let execution: Promise<void> | undefined;

        expect(() => {
            execution = context.runWithMode("full_access", () => {
                observedModes.push(context.mode);
                throw new Error("Synchronous execution failed.");
            });
        }).not.toThrow();

        await expect(execution).rejects.toThrow("Synchronous execution failed.");
        expect(observedModes).toEqual(["full_access"]);
        expect(context.mode).toBe("auto");
    });
});
