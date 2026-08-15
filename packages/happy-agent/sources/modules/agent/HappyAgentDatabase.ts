import { pathToFileURL } from "node:url";

import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";

export interface HappyAgentDatabase {
    readonly database: LibSQLDatabase;
    close(): void;
}

/** Open the loader-owned SQLite database through libSQL's asynchronous Drizzle driver. */
export async function openHappyAgentDatabase(path: string): Promise<HappyAgentDatabase> {
    const client = createClient({
        intMode: "number",
        timeout: 5_000,
        url: pathToFileURL(path).href,
    });
    try {
        await configure(client);
        const database = drizzle(client);
        serializeTransactions(database);
        return {
            database,
            close: () => client.close(),
        };
    } catch (error) {
        client.close();
        throw error;
    }
}

/**
 * libSQL's local client exposes one SQLite connection and rejects overlapping root transactions.
 * Agent Base deliberately delegates transaction concurrency to the host driver, so the local host
 * supplies a FIFO boundary here. Nested Agent Storage work reuses its transaction context and
 * never re-enters this queue.
 */
function serializeTransactions(database: LibSQLDatabase): void {
    const original = database.transaction.bind(database);
    let available = Promise.resolve();
    const serialized = async (...args: Parameters<typeof original>) => {
        const previous = available;
        let release!: () => void;
        available = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            return await original(...args);
        } finally {
            release();
        }
    };
    Object.defineProperty(database, "transaction", {
        configurable: false,
        enumerable: false,
        value: serialized,
        writable: false,
    });
}

async function configure(client: Client): Promise<void> {
    await client.execute("PRAGMA journal_mode = WAL");
    await client.execute("PRAGMA synchronous = FULL");
    await client.execute("PRAGMA foreign_keys = ON");
    await client.execute("PRAGMA busy_timeout = 250");
    await awaitCrashRecovery(client);
    await client.execute("PRAGMA busy_timeout = 5000");
}

async function awaitCrashRecovery(client: Client): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
            const transaction = await client.transaction("write");
            await transaction.rollback();
            return;
        } catch (error) {
            if (!isBusy(error) || attempt === 19) throw error;
            await new Promise<void>((resolve) => {
                setTimeout(resolve, Math.min(25 * (attempt + 1), 250));
            });
        }
    }
}

function isBusy(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "SQLITE_BUSY";
}
