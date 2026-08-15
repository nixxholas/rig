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
        return {
            database: drizzle(client),
            close: () => client.close(),
        };
    } catch (error) {
        client.close();
        throw error;
    }
}

async function configure(client: Client): Promise<void> {
    await client.execute("PRAGMA journal_mode = WAL");
    await client.execute("PRAGMA synchronous = FULL");
    await client.execute("PRAGMA foreign_keys = ON");
    await client.execute("PRAGMA busy_timeout = 5000");
}
