import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { PersistentSessionStore } from "../../packages/rig/sources/server/PersistentSessionStore.js";
import { initializeSessionDatabase } from "../../packages/rig/sources/server/initializeSessionDatabase.js";

import {
    assertExpectedRigDatabaseStartupChanges,
    inspectRigDatabase,
    readRigDatabaseCatalog,
    readRigDatabaseStartupState,
} from "./inspectRigDatabase.js";
import { queryRigDatabaseApi } from "./queryRigDatabaseApi.js";

export async function verifyRigDatabaseUpgrade(options: {
    fullIntegrityCheck?: boolean;
    keep?: boolean;
    sourcePath: string;
}): Promise<void> {
    const sourcePath = resolve(options.sourcePath);
    if (!existsSync(sourcePath)) throw new Error(`Rig database not found: ${sourcePath}`);

    const temporaryDirectory = await mkdtemp(join(tmpdir(), "rig-database-upgrade-"));
    const databasePath = join(temporaryDirectory, "sessions.sqlite");
    const socketPath = join(temporaryDirectory, "server.sock");
    let store: PersistentSessionStore | undefined;
    try {
        console.log(`Inspecting source database: ${sourcePath}`);
        const before = inspectRigDatabase(sourcePath, {
            fullIntegrityCheck: options.fullIntegrityCheck ?? false,
        });
        assertHealthy(before);

        console.log(`Creating consistent SQLite backup: ${databasePath}`);
        const source = new DatabaseSync(sourcePath, { readOnly: true });
        try {
            await backup(source, databasePath);
        } finally {
            source.close();
        }

        const copiedBefore = inspectRigDatabase(databasePath, {
            fullIntegrityCheck: options.fullIntegrityCheck ?? false,
        });
        assertHealthy(copiedBefore);
        const startupState = readRigDatabaseStartupState(databasePath);

        console.log("Opening the backup with the current PersistentSessionStore");
        store = new PersistentSessionStore({
            databasePath,
            projectGit: async () => "",
            stateDirectory: temporaryDirectory,
        });

        const after = inspectRigDatabase(databasePath, {
            fullIntegrityCheck: options.fullIntegrityCheck ?? false,
        });
        assertHealthy(after);
        const expectedSchemaVersion = currentSchemaVersion();
        if (after.schemaVersion !== expectedSchemaVersion) {
            throw new Error(
                `The upgraded database is schema ${String(after.schemaVersion)}; expected ${String(expectedSchemaVersion)}.`,
            );
        }
        assertPreservedCounts(copiedBefore, after, startupState);
        assertExpectedRigDatabaseStartupChanges(databasePath, startupState);

        console.log("Querying the copied database through the authenticated Rig API");
        const api = await queryRigDatabaseApi({
            catalog: readRigDatabaseCatalog(databasePath),
            socketPath,
            store,
            token: randomUUID(),
        });

        console.log(
            JSON.stringify(
                {
                    api,
                    copy: options.keep === true ? databasePath : "removed after verification",
                    database: after,
                    result: "ok",
                },
                null,
                2,
            ),
        );
    } finally {
        store?.close();
        if (options.keep !== true) {
            await rm(temporaryDirectory, { force: true, recursive: true });
        } else {
            console.log(`Kept upgraded copy in ${temporaryDirectory}`);
        }
    }
}

function currentSchemaVersion(): number {
    const database = new DatabaseSync(":memory:");
    try {
        initializeSessionDatabase(database);
        const value = database.prepare("PRAGMA user_version").get()?.user_version;
        if (typeof value !== "number" && typeof value !== "bigint") {
            throw new Error("The current schema version could not be read.");
        }
        return Number(value);
    } finally {
        database.close();
    }
}

function assertHealthy(inspection: ReturnType<typeof inspectRigDatabase>): void {
    const failures = [
        inspection.integrity === "ok" ? undefined : `integrity: ${inspection.integrity}`,
        inspection.foreignKeyViolations === 0
            ? undefined
            : `${String(inspection.foreignKeyViolations)} foreign-key violations`,
        inspection.invalidJsonRows === 0
            ? undefined
            : `${String(inspection.invalidJsonRows)} invalid JSON rows`,
        inspection.missingColumns.length === 0
            ? undefined
            : `missing columns: ${inspection.missingColumns.join(", ")}`,
    ].filter((failure): failure is string => failure !== undefined);
    if (failures.length > 0) throw new Error(`Database check failed: ${failures.join("; ")}`);
}

function assertPreservedCounts(
    before: ReturnType<typeof inspectRigDatabase>,
    after: ReturnType<typeof inspectRigDatabase>,
    startupState: ReturnType<typeof readRigDatabaseStartupState>,
): void {
    const expected = {
        ...before.counts,
        activeRootSessions:
            before.counts.activeRootSessions - startupState.runningAutoArchiveSessions,
        sessionEvents: before.counts.sessionEvents + startupState.runningSessionIds.length * 2,
    };
    if (JSON.stringify(expected) !== JSON.stringify(after.counts)) {
        throw new Error(
            `Startup changed unexpected durable row counts.\nExpected: ${JSON.stringify(expected)}\nAfter: ${JSON.stringify(after.counts)}`,
        );
    }
}

function parseArguments(arguments_: readonly string[]): {
    fullIntegrityCheck: boolean;
    keep: boolean;
    sourcePath: string;
} {
    const positional = arguments_.filter((argument) => !argument.startsWith("--"));
    const unknownFlags = arguments_.filter(
        (argument) => argument.startsWith("--") && argument !== "--full" && argument !== "--keep",
    );
    if (unknownFlags.length > 0 || positional.length > 1) {
        throw new Error("Usage: pnpm database:verify-upgrade [database-path] [--full] [--keep]");
    }
    return {
        fullIntegrityCheck: arguments_.includes("--full"),
        keep: arguments_.includes("--keep"),
        sourcePath: positional[0] ?? join(homedir(), ".rig", "sessions.sqlite"),
    };
}

const isMain =
    process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    void verifyRigDatabaseUpgrade(parseArguments(process.argv.slice(2))).catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
