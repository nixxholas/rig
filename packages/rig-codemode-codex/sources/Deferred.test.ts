import { describe, expect, test } from "vitest";

import { Deferred } from "./Deferred.js";

describe("Deferred", () => {
    test("delivers the settled value to a later awaiter", async () => {
        const deferred = new Deferred<number>();
        deferred.resolve(42);

        await expect(deferred.promise).resolves.toBe(42);
    });

    test("delivers a rejection raised before anything awaits it", async () => {
        const deferred = new Deferred<number>();
        deferred.reject(new Error("Code Mode host exited."));

        await expect(deferred.promise).rejects.toThrow("Code Mode host exited.");
    });

    test("does not report an unhandled rejection when nothing awaits it", async () => {
        const rejections: unknown[] = [];
        const onUnhandled = (reason: unknown) => rejections.push(reason);
        process.on("unhandledRejection", onUnhandled);
        try {
            new Deferred<number>().reject(new Error("Code Mode host exited."));
            await new Promise((resolve) => setTimeout(resolve, 10));
        } finally {
            process.off("unhandledRejection", onUnhandled);
        }

        expect(rejections).toEqual([]);
    });
});
