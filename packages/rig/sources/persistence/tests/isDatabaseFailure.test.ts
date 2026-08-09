import { createClient, type Client } from "@libsql/client";
import { describe, expect, it } from "vitest";

import { isDatabaseFailure } from "../isDatabaseFailure.js";

/**
 * Captures the error the driver actually throws, so the classifier is tested against real driver
 * behavior rather than against a hand-written imitation of it.
 */
async function captureDriverError(act: (database: Client) => Promise<void>): Promise<unknown> {
    const database = createClient({ intMode: "number", url: "file::memory:" });
    try {
        await act(database);
        throw new Error("Expected the driver to fail.");
    } catch (error) {
        return error;
    } finally {
        database.close();
    }
}

describe("isDatabaseFailure", () => {
    it("recognizes a driver error that carries a SQLite code", async () => {
        const error = await captureDriverError(async (database) => {
            await database.execute("select * from missing_table");
        });

        expect((error as Error).name).toBe("LibsqlError");
        expect(isDatabaseFailure(error)).toBe(true);
    });

    it("recognizes a closed client error", async () => {
        const error = await captureDriverError(async (database) => {
            database.close();
            await database.execute("select 1");
        });

        expect((error as Error & { code?: string }).code).toBe("CLIENT_CLOSED");
        expect(isDatabaseFailure(error)).toBe(true);
    });

    it("recognizes an unbindable value reported as a plain error", async () => {
        const error = await captureDriverError(async (database) => {
            await database.execute({
                args: [Symbol("value") as never],
                sql: "select ?",
            });
        });

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(
            "SQLite3 can only bind numbers, strings, bigints, buffers, and null",
        );
        expect(isDatabaseFailure(error)).toBe(true);
    });

    it("finds a driver failure wrapped as a cause", async () => {
        const driverError = await captureDriverError(async (database) => {
            await database.execute("select * from missing_table");
        });

        expect(
            isDatabaseFailure(new Error("Saving the session failed.", { cause: driverError })),
        ).toBe(true);
    });

    it("finds a driver failure inside an aggregate error", async () => {
        const driverError = await captureDriverError(async (database) => {
            database.close();
            await database.execute("select 1");
        });

        expect(isDatabaseFailure(new AggregateError([new Error("Unrelated."), driverError]))).toBe(
            true,
        );
    });

    it("treats an ordinary programming mistake as recoverable", () => {
        expect(isDatabaseFailure(new TypeError("value is not a function"))).toBe(false);
        expect(isDatabaseFailure(new Error("The project version changed before saving."))).toBe(
            false,
        );
        expect(isDatabaseFailure("The session could not be created.")).toBe(false);
        expect(isDatabaseFailure(undefined)).toBe(false);
    });

    it("stops on a cause that points back at itself", () => {
        const error = new Error("Saving failed.");
        error.cause = error;

        expect(isDatabaseFailure(error)).toBe(false);
    });
});
