import { killProcessTree } from "./killProcessTree.js";

/**
 * Remembers the process groups we started so shutdown can take them down.
 *
 * A background command outlives the shell that launched it, so a group has to
 * stay reapable long after its leader is gone. Groups are pruned lazily; a
 * process group is alive while any member is.
 */
export class ProcessGroupReaper {
    readonly #groups = new Set<number>();

    retain(processGroupId: number): void {
        if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0) return;
        this.#prune();
        this.#groups.add(processGroupId);
    }

    release(processGroupId: number): void {
        this.#groups.delete(processGroupId);
    }

    /** The groups we would take down right now, for tests and diagnostics. */
    pending(): readonly number[] {
        this.#prune();
        return [...this.#groups];
    }

    /** Asks every remaining group to stop, then forces the ones that did not. */
    async terminateAll(forceAfterMs: number): Promise<void> {
        const groups = [...this.#groups];
        this.#groups.clear();
        if (groups.length === 0) return;
        for (const processGroupId of groups) killProcessTree(processGroupId, "SIGTERM");
        if (forceAfterMs > 0) {
            await new Promise((resolve) => {
                setTimeout(resolve, forceAfterMs).unref();
            });
        }
        for (const processGroupId of groups) {
            if (isProcessGroupAlive(processGroupId)) killProcessTree(processGroupId, "SIGKILL");
        }
    }

    #prune(): void {
        if (process.platform === "win32") return;
        for (const processGroupId of this.#groups) {
            if (!isProcessGroupAlive(processGroupId)) this.#groups.delete(processGroupId);
        }
    }
}

function isProcessGroupAlive(processGroupId: number): boolean {
    try {
        process.kill(-processGroupId, 0);
        return true;
    } catch (error) {
        return (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            (error as { code?: unknown }).code === "EPERM"
        );
    }
}
