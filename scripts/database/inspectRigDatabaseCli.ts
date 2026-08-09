import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { inspectRigDatabase } from "./inspectRigDatabase.js";

function parseArguments(arguments_: readonly string[]): {
    fullIntegrityCheck: boolean;
    sourcePath: string;
} {
    const positional = arguments_.filter((argument) => !argument.startsWith("--"));
    const unknownFlags = arguments_.filter(
        (argument) => argument.startsWith("--") && argument !== "--full",
    );
    if (unknownFlags.length > 0 || positional.length > 1) {
        throw new Error("Usage: pnpm database:inspect [database-path] [--full]");
    }
    return {
        fullIntegrityCheck: arguments_.includes("--full"),
        sourcePath: positional[0] ?? join(homedir(), ".happy", "rig", "sessions.sqlite"),
    };
}

const isMain =
    process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    try {
        const options = parseArguments(process.argv.slice(2));
        console.log(
            JSON.stringify(
                await inspectRigDatabase(resolve(options.sourcePath), {
                    fullIntegrityCheck: options.fullIntegrityCheck,
                }),
                null,
                2,
            ),
        );
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
