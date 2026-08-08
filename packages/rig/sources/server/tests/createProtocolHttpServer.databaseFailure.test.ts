import { rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

import { InMemorySessionStore } from "../../session/InMemorySessionStore.js";
import { createTestSocketDirectory } from "../../testing/createTestSocketDirectory.js";
import { createProtocolHttpServer } from "../createProtocolHttpServer.js";

describe("createProtocolHttpServer database failures", () => {
    it("escapes a route recovery catch as an unhandled rejection", async () => {
        const store = new InMemorySessionStore();
        const error = captureDriverError((database) => {
            database.prepare("select * from missing_table").all();
        });
        vi.spyOn(store, "registerSecret").mockImplementation(() => {
            throw error;
        });

        const directory = await createTestSocketDirectory();
        const socketPath = join(directory, "server.sock");
        const server = createProtocolHttpServer({ store, token: "secret" });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(socketPath, () => {
                server.off("error", reject);
                resolve();
            });
        });

        const request = httpRequest({
            headers: {
                authorization: "Bearer secret",
                "content-type": "application/json",
            },
            method: "POST",
            path: "/secrets",
            socketPath,
        });
        let responseReceived = false;
        request.once("response", () => {
            responseReceived = true;
        });
        request.on("error", () => {});

        try {
            const escaped = await captureUnhandledRejection(async () => {
                request.end(
                    JSON.stringify({
                        description: "Database failure test",
                        environment: { TEST_TOKEN: "value" },
                        id: "database-failure",
                    }),
                );
            });
            expect(escaped).toBe(error);
            expect(responseReceived).toBe(false);
        } finally {
            request.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            store.close();
            await rm(directory, { force: true, recursive: true });
        }
    });
});

async function captureUnhandledRejection(run: () => Promise<void>): Promise<unknown> {
    const installed = process.listeners("unhandledRejection");
    for (const listener of installed) process.off("unhandledRejection", listener);
    let captured: unknown;
    const observe = (reason: unknown): void => {
        captured ??= reason;
    };
    process.on("unhandledRejection", observe);
    try {
        await run();
        for (let attempt = 0; attempt < 200 && captured === undefined; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return captured;
    } finally {
        process.off("unhandledRejection", observe);
        for (const listener of installed) process.on("unhandledRejection", listener);
    }
}

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
