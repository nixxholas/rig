import { randomUUID } from "node:crypto";

import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentDatabase,
    type AgentModule,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";

/** What this `.happy` folder has been since the first time anyone started here. */
interface Installation {
    readonly epoch: string;
    readonly schemaVersion: number;
}

/**
 * Which installation this `.happy` folder has been.
 *
 * The epoch is the one thing about a machine that nothing else can invent: it distinguishes this
 * folder from a copy of it restored somewhere else, which is what lets a project refuse to be
 * cloned with another machine's credentials. It is read out of the folder's own state as the
 * modules start, and everything that needs it asks this one rather than being handed the answer.
 *
 * It is a module so that its table is created by the same migration pass as everything else, and
 * so that the epoch is settled before any module that depends on it is asked for anything.
 */
export class InstallationModule implements AgentModule<AnyAgentTool, LibSQLDatabase> {
    readonly name = "happy-agent-installation";
    readonly migrations = [
        [
            "001-root-agent",
            async (_ctx: Context, database: AgentDatabase) => {
                await agentDatabaseRun(
                    database,
                    sql`CREATE TABLE IF NOT EXISTS happy_agent_loader_state (
                        key TEXT PRIMARY KEY,
                        value TEXT NOT NULL
                    )`,
                );
            },
        ],
        [
            // The daemon no longer has an agent of its own, so the identity it used to keep here
            // names nothing. It is deleted rather than left behind, because a stored identity that
            // nothing reads is the kind of thing a later reader mistakes for the truth.
            "002-drop-root-agent",
            async (_ctx: Context, database: AgentDatabase) => {
                await agentDatabaseRun(
                    database,
                    sql`DELETE FROM happy_agent_loader_state WHERE key = 'root_agent_id'`,
                );
            },
        ],
    ] as const satisfies AgentModule<AnyAgentTool, LibSQLDatabase>["migrations"];

    #installation: Installation | undefined;

    readonly beforeStart = async (ctx: Context): Promise<void> => {
        this.#installation = await ctx.inTx(async (txCtx) => await readInstallation(txCtx.db));
    };

    /** When this folder was first started here, which distinguishes it from a restored copy. */
    get epoch(): string {
        return this.#read().epoch;
    }

    /** The generation of the stored schema this folder is on. */
    get schemaVersion(): number {
        return this.#read().schemaVersion;
    }

    #read(): Installation {
        if (this.#installation === undefined) {
            throw new Error("The Happy agent identity was not established while starting.");
        }
        return this.#installation;
    }
}

async function readInstallation(database: AgentDatabase): Promise<Installation> {
    const rows = await agentDatabaseRows<{ key: string; value: string }>(
        database,
        sql`SELECT key, value FROM happy_agent_loader_state
            WHERE key IN ('installation_epoch', 'schema_version')`,
    );
    const values = new Map(rows.map((row) => [row.key, row.value]));
    const epoch = values.get("installation_epoch") ?? randomUUID();
    const storedVersion = values.get("schema_version");
    const schemaVersion = storedVersion === undefined ? 1 : Number.parseInt(storedVersion, 10);
    if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
        throw new Error("The stored Happy agent schema version is invalid.");
    }
    for (const [key, value] of [
        ["installation_epoch", epoch],
        ["schema_version", String(schemaVersion)],
    ] as const) {
        if (values.has(key)) continue;
        await agentDatabaseRun(
            database,
            sql`INSERT INTO happy_agent_loader_state (key, value) VALUES (${key}, ${value})`,
        );
    }
    return { epoch, schemaVersion };
}
