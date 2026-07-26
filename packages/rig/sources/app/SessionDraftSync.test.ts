import { describe, expect, it } from "vitest";

import { SessionDraftSync } from "./SessionDraftSync.js";

interface Harness {
    pushed: string[];
    runTimer: () => void;
    sync: SessionDraftSync;
}

function createHarness(
    options: { draft?: string; push?: (draft: string) => Promise<void> } = {},
): Harness {
    const pushed: string[] = [];
    let scheduled: (() => void) | undefined;
    const sync = new SessionDraftSync({
        origin: "terminal-a",
        ...(options.draft === undefined ? {} : { draft: options.draft }),
        push:
            options.push ??
            ((draft) => {
                pushed.push(draft);
                return Promise.resolve();
            }),
        setTimer: (callback) => {
            scheduled = callback;
            return 0 as unknown as NodeJS.Timeout;
        },
        clearTimer: () => {
            scheduled = undefined;
        },
    });
    return {
        pushed,
        runTimer: () => {
            const callback = scheduled;
            scheduled = undefined;
            callback?.();
        },
        sync,
    };
}

describe("SessionDraftSync", () => {
    it("coalesces typing into one write per pause", async () => {
        const { pushed, runTimer, sync } = createHarness();

        sync.recordLocalText("f");
        sync.recordLocalText("fi");
        sync.recordLocalText("fix");
        expect(pushed).toEqual([]);

        runTimer();
        await sync.flush();
        expect(pushed).toEqual(["fix"]);
    });

    it("does not write a draft that already matches the daemon", async () => {
        const { pushed, runTimer, sync } = createHarness({ draft: "restored" });

        sync.recordLocalText("restored");
        runTimer();
        await sync.flush();

        expect(pushed).toEqual([]);
    });

    it("ignores the echo of its own draft", () => {
        const { sync } = createHarness();

        expect(sync.applyRemoteDraft("mine", "terminal-a")).toBeUndefined();
    });

    it("adopts a draft written by another client", () => {
        const { sync } = createHarness();

        expect(sync.applyRemoteDraft("from the phone", "phone")).toBe("from the phone");
    });

    it("keeps local text when an unsent local edit is newer", async () => {
        const { pushed, runTimer, sync } = createHarness();

        sync.recordLocalText("typing here");
        expect(sync.applyRemoteDraft("from the phone", "phone")).toBeUndefined();

        runTimer();
        await sync.flush();
        expect(pushed).toEqual(["typing here"]);
    });

    it("stops writing once disposed so teardown does not clear the draft", async () => {
        const { pushed, runTimer, sync } = createHarness({ draft: "unsent work" });

        sync.dispose();
        sync.recordLocalText("");
        runTimer();
        await sync.flush();

        expect(pushed).toEqual([]);
    });

    it("writes drafts in order even when a request is slow", async () => {
        const resolvers: (() => void)[] = [];
        const pushed: string[] = [];
        const { runTimer, sync } = createHarness({
            push: (draft) => {
                pushed.push(draft);
                return new Promise<void>((resolve) => resolvers.push(resolve));
            },
        });

        sync.recordLocalText("first");
        runTimer();
        sync.recordLocalText("second");
        runTimer();

        // The second draft waits for the slow first request instead of racing it.
        expect(pushed).toEqual(["first"]);

        resolvers[0]?.();
        await new Promise((resolve) => setImmediate(resolve));
        expect(pushed).toEqual(["first", "second"]);

        resolvers[1]?.();
        await sync.flush();
    });

    it("reports a failed write and re-sends the next edit", async () => {
        const attempts: string[] = [];
        const errors: unknown[] = [];
        let scheduled: (() => void) | undefined;
        const sync = new SessionDraftSync({
            origin: "terminal-a",
            push: (draft) => {
                attempts.push(draft);
                return attempts.length === 1
                    ? Promise.reject(new Error("daemon unavailable"))
                    : Promise.resolve();
            },
            onError: (error) => errors.push(error),
            setTimer: (callback) => {
                scheduled = callback;
                return 0 as unknown as NodeJS.Timeout;
            },
            clearTimer: () => {
                scheduled = undefined;
            },
        });

        sync.recordLocalText("draft");
        scheduled?.();
        await sync.flush();
        expect(attempts).toEqual(["draft"]);
        expect(errors).toHaveLength(1);

        sync.recordLocalText("draft more");
        scheduled?.();
        await sync.flush();
        expect(attempts).toEqual(["draft", "draft more"]);
    });
});
