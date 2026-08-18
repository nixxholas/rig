import { randomUUID } from "node:crypto";

import { createId } from "@paralleldrive/cuid2";
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
    readonly rootAgentId: string;
    readonly schemaVersion: number;
}

/**
 * Who this installation is: which conversation is its root, and which installation it has been.
 *
 * The root agent's identity is the one thing about a machine that nothing else can invent. It is
 * read out of the folder's own state as the modules start, and every module that needs to know
 * which agent this installation acts as asks this one rather than being handed the answer.
 *
 * It is a module so that its table is created by the same migration pass as everything else, and
 * so that the identity is settled before any module that depends on it is asked for anything.
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
    ] as const satisfies AgentModule<AnyAgentTool, LibSQLDatabase>["migrations"];

    #installation: Installation | undefined;

    readonly beforeStart = async (ctx: Context): Promise<void> => {
        this.#installation = await ctx.inTx(async (txCtx) => await readInstallation(txCtx.db));
    };

    /** When this folder was first started here, which distinguishes it from a restored copy. */
    get epoch(): string {
        return this.#read().epoch;
    }

    /** The agent this installation acts as. */
    get rootAgentId(): string {
        return this.#read().rootAgentId;
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
            WHERE key IN ('root_agent_id', 'installation_epoch', 'schema_version')`,
    );
    const values = new Map(rows.map((row) => [row.key, row.value]));
    const rootAgentId = values.get("root_agent_id") ?? createId();
    if (!/^[a-z][a-z0-9]+$/.test(rootAgentId)) {
        throw new Error("The stored root agent identity is invalid.");
    }
    const epoch = values.get("installation_epoch") ?? randomUUID();
    const storedVersion = values.get("schema_version");
    const schemaVersion = storedVersion === undefined ? 1 : Number.parseInt(storedVersion, 10);
    if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
        throw new Error("The stored Happy agent schema version is invalid.");
    }
    for (const [key, value] of [
        ["root_agent_id", rootAgentId],
        ["installation_epoch", epoch],
        ["schema_version", String(schemaVersion)],
    ] as const) {
        if (values.has(key)) continue;
        await agentDatabaseRun(
            database,
            sql`INSERT INTO happy_agent_loader_state (key, value) VALUES (${key}, ${value})`,
        );
    }
    return { epoch, rootAgentId, schemaVersion };
}
