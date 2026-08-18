import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { openHappyAgentDatabase } from "../../sources/runtime/HappyAgentDatabase.js";

const createdDirectories = new Set<string>();

afterEach(async () => {
    await Promise.all(
        [...createdDirectories].map(async (directory) => {
            await rm(directory, { force: true, recursive: true });
        }),
    );
    createdDirectories.clear();
});

describe("openHappyAgentDatabase", () => {
    it("queues a root statement behind an active transaction", async () => {
        const directory = await createTestDirectory();
        const opened = await openHappyAgentDatabase(join(directory, "agent.sqlite"));
        const { database } = opened;
        try {
            await database.run(sql`CREATE TABLE writes (value TEXT NOT NULL)`);
            await database.run(sql`PRAGMA busy_timeout = 1`);

            const entered = deferred<void>();
            const release = deferred<void>();
            const transaction = database.transaction(async (tx) => {
                await tx.run(sql`INSERT INTO writes (value) VALUES ('transaction')`);
                entered.resolve();
                await release.promise;
            });
            await entered.promise;

            const rootWrite = database.run(sql`INSERT INTO writes (value) VALUES ('root')`);
            await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
            release.resolve();

            await expect(Promise.all([transaction, rootWrite])).resolves.toBeDefined();
            await expect(
                database.all<{ value: string }>(sql`SELECT value FROM writes ORDER BY rowid`),
            ).resolves.toEqual([{ value: "transaction" }, { value: "root" }]);
        } finally {
            opened.close();
        }
    });
});

async function createTestDirectory(): Promise<string> {
    const scratch = resolve(import.meta.dirname, "../../../.context");
    await mkdir(scratch, { recursive: true });
    const directory = await mkdtemp(join(scratch, "happy-agent-database-"));
    createdDirectories.add(directory);
    return directory;
}

function deferred<Value>(): {
    readonly promise: Promise<Value>;
    resolve(value: Value): void;
} {
    let resolve!: (value: Value) => void;
    const promise = new Promise<Value>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}
