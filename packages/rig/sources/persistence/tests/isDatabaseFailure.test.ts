import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { isDatabaseFailure } from "../isDatabaseFailure.js";

/**
 * Captures the error the driver actually throws, so the classifier is tested against real driver
 * behavior rather than against a hand-written imitation of it.
 */
function captureDriverError(act: (database: Database.Database) => void): unknown {
    const database = new Database(":memory:");
    try {
        act(database);
        throw new Error("Expected the driver to fail.");
    } catch (error) {
        return error;
    } finally {
        if (database.open) database.close();
    }
}

describe("isDatabaseFailure", () => {
    it("recognizes a driver error that carries a SQLite code", () => {
        const error = captureDriverError((database) => {
            database.prepare("select * from missing_table").all();
        });

        expect((error as Error).name).toBe("SqliteError");
        expect(isDatabaseFailure(error)).toBe(true);
    });

    it("recognizes a closed connection reported as a plain TypeError", () => {
        const error = captureDriverError((database) => {
            database.close();
            database.prepare("select 1");
        });

        expect(error).toBeInstanceOf(TypeError);
        expect((error as Error).message).toBe("The database connection is not open");
        expect(isDatabaseFailure(error)).toBe(true);
    });

    it("recognizes a busy connection reported as a plain TypeError", () => {
        const error = captureDriverError((database) => {
            database.exec("create table rows (value integer)");
            database.prepare("insert into rows values (1)").run();
            for (const _row of database.prepare("select value from rows").iterate()) {
                database.exec("create table blocked (value integer)");
            }
        });

        expect(error).toBeInstanceOf(TypeError);
        expect((error as Error).message).toBe("This database connection is busy executing a query");
        expect(isDatabaseFailure(error)).toBe(true);
    });

    it("recognizes a busy statement reported as a plain TypeError", () => {
        const error = captureDriverError((database) => {
            const statement = database.prepare("select 1 union all select 2");
            for (const _row of statement.iterate()) statement.all();
        });

        expect(error).toBeInstanceOf(TypeError);
        expect((error as Error).message).toBe("This statement is busy executing a query");
        expect(isDatabaseFailure(error)).toBe(true);
    });

    it("recognizes an unbindable value reported as a plain TypeError", () => {
        const error = captureDriverError((database) => {
            database.exec("create table rows (value integer)");
            database.prepare("insert into rows values (?)").run(Symbol("value"));
        });

        expect(error).toBeInstanceOf(TypeError);
        expect((error as Error).message).toBe(
            "SQLite3 can only bind numbers, strings, bigints, buffers, and null",
        );
        expect(isDatabaseFailure(error)).toBe(true);
    });

    it("finds a driver failure wrapped as a cause", () => {
        const driverError = captureDriverError((database) => {
            database.prepare("select * from missing_table").all();
        });

        expect(
            isDatabaseFailure(new Error("Saving the session failed.", { cause: driverError })),
        ).toBe(true);
    });

    it("finds a driver failure inside an aggregate error", () => {
        const driverError = captureDriverError((database) => {
            database.close();
            database.prepare("select 1");
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
