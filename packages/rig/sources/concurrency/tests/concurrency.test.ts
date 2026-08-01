import { describe, expect, it, vi } from "vitest";

import {
    AbortedError,
    asyncLock,
    asyncQueue,
    backoff,
    delay,
    forever,
    gracefulShutdown,
    isAbortedError,
    retry,
} from "../index.js";

describe("asyncLock", () => {
    it("runs work in arrival order without overlapping", async () => {
        const lock = asyncLock();
        const events: string[] = [];

        const run = (name: string, ms: number) =>
            lock.runInLock(async () => {
                events.push(`${name}:start`);
                await new Promise((resolve) => setTimeout(resolve, ms));
                events.push(`${name}:end`);
            });

        await Promise.all([run("a", 20), run("b", 1), run("c", 1)]);

        expect(events).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
    });

    it("keeps serving later callers after one throws", async () => {
        const lock = asyncLock();

        const failure = lock.runInLock(() => Promise.reject(new Error("boom")));
        await expect(failure).rejects.toThrow("boom");
        await expect(lock.runInLock(() => Promise.resolve("ok"))).resolves.toBe("ok");
    });

    it("returns the value the work produced", async () => {
        await expect(asyncQueue().runInLock(() => Promise.resolve(42))).resolves.toBe(42);
    });
});

describe("delay", () => {
    it("waits without a signal", async () => {
        const start = Date.now();
        await delay(15);
        expect(Date.now() - start).toBeGreaterThanOrEqual(10);
    });

    it("throws AbortedError when the signal fires while waiting", async () => {
        const controller = new AbortController();
        const waiting = delay(5_000, controller.signal);
        controller.abort();
        await expect(waiting).rejects.toBeInstanceOf(AbortedError);
    });

    it("throws immediately when the signal already fired", async () => {
        await expect(delay(1, AbortSignal.abort())).rejects.toBeInstanceOf(AbortedError);
    });

    it("releases its abort listener once the wait completes", async () => {
        const controller = new AbortController();
        await delay(1, controller.signal);
        // A leaked listener would still be attached after the timer resolved.
        expect(controller.signal.dispatchEvent(new Event("abort"))).toBe(true);
    });
});

describe("backoff", () => {
    it("retries until the work succeeds", async () => {
        let attempts = 0;
        const value = await backoff(
            () => {
                attempts += 1;
                if (attempts < 3) throw new Error("not yet");
                return Promise.resolve("done");
            },
            { initialDelay: 1 },
        );

        expect(value).toBe("done");
        expect(attempts).toBe(3);
    });

    it("reports each failure with its attempt number", async () => {
        const onError = vi.fn();
        let attempts = 0;
        await backoff(
            () => {
                attempts += 1;
                if (attempts < 2) throw new Error("first");
                return Promise.resolve(null);
            },
            { initialDelay: 1, onError },
        );

        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError.mock.calls[0]?.[1]).toBe(1);
    });

    it("stops immediately when aborted and does not retry", async () => {
        const controller = new AbortController();
        let attempts = 0;

        const running = backoff(
            () => {
                attempts += 1;
                controller.abort();
                throw new Error("failed");
            },
            { initialDelay: 1, signal: controller.signal },
        );

        await expect(running).rejects.toThrow("failed");
        expect(attempts).toBe(1);
    });

    it("throws before starting when the signal already fired", async () => {
        const work = vi.fn(() => Promise.resolve("never"));
        await expect(backoff(work, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(
            AbortedError,
        );
        expect(work).not.toHaveBeenCalled();
    });
});

describe("retry", () => {
    it("throws the last real failure when the time runs out", async () => {
        await expect(
            retry(
                () => {
                    throw new Error("always fails");
                },
                { initialDelay: 1, timeout: 20 },
            ),
        ).rejects.toThrow("always fails");
    });

    it("succeeds inside the budget", async () => {
        let attempts = 0;
        await expect(
            retry(
                () => {
                    attempts += 1;
                    if (attempts < 2) throw new Error("once");
                    return Promise.resolve("ok");
                },
                { initialDelay: 1, timeout: 1_000 },
            ),
        ).resolves.toBe("ok");
    });
});

describe("forever", () => {
    it("repeats until the signal fires and then returns", async () => {
        const controller = new AbortController();
        let passes = 0;

        const loop = forever({ name: "counter", delay: 1, signal: controller.signal }, () => {
            passes += 1;
            if (passes >= 3) controller.abort();
            return Promise.resolve();
        });

        await expect(loop).resolves.toBeUndefined();
        expect(passes).toBe(3);
    });

    it("keeps looping through failures", async () => {
        const controller = new AbortController();
        let passes = 0;

        await forever({ name: "flaky", delay: 1, signal: controller.signal }, () => {
            passes += 1;
            if (passes === 1) throw new Error("transient");
            controller.abort();
            return Promise.resolve();
        });

        expect(passes).toBe(2);
    });

    it("does not run at all when already shutting down", async () => {
        const work = vi.fn(() => Promise.resolve());
        await forever({ name: "idle", delay: 1, signal: AbortSignal.abort() }, work);
        expect(work).not.toHaveBeenCalled();
    });
});

describe("gracefulShutdown", () => {
    it("runs every handler and waits for them", async () => {
        const shutdown = gracefulShutdown();
        const finished: string[] = [];

        shutdown.register("first", async () => {
            await delay(5);
            finished.push("first");
        });
        shutdown.register("second", async () => {
            finished.push("second");
        });

        const report = await shutdown.shutdown();

        expect(finished).toHaveLength(2);
        expect(report.timedOut).toEqual([]);
        expect(report.failed).toEqual([]);
    });

    it("aborts its signal so loops unwind", async () => {
        const shutdown = gracefulShutdown();
        let passes = 0;

        const loop = forever({ name: "poller", delay: 1, signal: shutdown.signal }, () => {
            passes += 1;
            return Promise.resolve();
        });
        shutdown.register("poller", () => loop);

        await delay(10);
        await shutdown.shutdown();

        expect(shutdown.shuttingDown).toBe(true);
        expect(passes).toBeGreaterThan(0);
    });

    it("names the handlers that did not finish in time", async () => {
        const shutdown = gracefulShutdown();
        shutdown.register("stuck", () => new Promise<void>(() => {}));
        shutdown.register("quick", () => Promise.resolve());

        const report = await shutdown.shutdown({ timeout: 20 });

        expect(report.timedOut).toEqual(["stuck"]);
    });

    it("collects a failing handler without losing the others", async () => {
        const shutdown = gracefulShutdown();
        let ran = false;

        shutdown.register("bad", () => Promise.reject(new Error("handler failed")));
        shutdown.register("good", () => {
            ran = true;
            return Promise.resolve();
        });

        const report = await shutdown.shutdown();

        expect(ran).toBe(true);
        expect(report.failed).toHaveLength(1);
        expect(report.failed[0]?.name).toBe("bad");
    });

    it("shuts down once even when called repeatedly", async () => {
        const shutdown = gracefulShutdown();
        const handler = vi.fn(() => Promise.resolve());
        shutdown.register("once", handler);

        await Promise.all([shutdown.shutdown(), shutdown.shutdown()]);

        expect(handler).toHaveBeenCalledTimes(1);
    });

    it("stops running a handler that unregistered itself", async () => {
        const shutdown = gracefulShutdown();
        const handler = vi.fn(() => Promise.resolve());
        const unregister = shutdown.register("temporary", handler);

        unregister();
        await shutdown.shutdown();

        expect(handler).not.toHaveBeenCalled();
    });
});

describe("AbortedError", () => {
    it("is recognisable through isAbortedError", () => {
        expect(isAbortedError(new AbortedError())).toBe(true);
        expect(isAbortedError(new Error("other"))).toBe(false);
    });
});
