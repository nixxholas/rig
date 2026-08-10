import { describe, expect, it, vi } from "vitest";

import { createTestRootContext } from "../testing/createTestRootContext.js";
import { ProjectRemoteTerminalStore } from "./ProjectRemoteTerminalStore.js";
import { RemoteTerminalManager } from "./RemoteTerminalManager.js";
import type {
    RemoteTerminalProcess,
    RemoteTerminalProcessFactory,
} from "./RemoteTerminalProcess.js";

describe("ProjectRemoteTerminalStore", () => {
    it("waits for a deferred terminal creation and disposes it while closing the project", async () => {
        const ctx = createTestRootContext();
        let releaseStart!: (process: RemoteTerminalProcess) => void;
        const startGate = new Promise<RemoteTerminalProcess>((resolve) => {
            releaseStart = resolve;
        });
        const start = vi.fn(() => startGate);
        const store = new ProjectRemoteTerminalStore({
            createManager: ({ cwd }) => createManager(cwd, { confinement: "host", start }),
            resolveContext: () => ({ cwd: "/project" }),
        });
        const scope = { projectId: "project-1" };
        const creation = store.create(ctx, scope, {});
        await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());

        const closure = store.closeProject(ctx, scope.projectId);
        await expect(store.create(ctx, scope, {})).rejects.toThrow("closing");
        let closed = false;
        void closure.then(() => {
            closed = true;
        });
        await Promise.resolve();
        expect(closed).toBe(false);

        const process = new FakeTerminalProcess();
        releaseStart(process);
        const terminal = await creation;
        await closure;

        expect(process.killed).toBe(true);
        expect(terminal.summary().status).toBe("exited");
        expect(store.list(scope)).toEqual([]);
    });
});

function createManager(cwd: string, processFactory: RemoteTerminalProcessFactory) {
    return new RemoteTerminalManager({
        cwd,
        processFactory,
        resolveCwd: (root, requested) => requested ?? root,
    });
}

class FakeTerminalProcess implements RemoteTerminalProcess {
    killed = false;
    #exit!: (value: { exitCode: number | null }) => void;
    readonly #exited = new Promise<{ exitCode: number | null }>((resolve) => {
        this.#exit = resolve;
    });

    kill(): void {
        if (this.killed) return;
        this.killed = true;
        this.#exit({ exitCode: 143 });
    }

    onData(): () => void {
        return () => {};
    }

    pause(): void {}

    resize(): void {}

    resume(): void {}

    wait(): Promise<{ exitCode: number | null }> {
        return this.#exited;
    }

    write(): boolean {
        return true;
    }
}
