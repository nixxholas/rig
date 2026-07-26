import { formatCliFailure } from "./formatCliFailure.js";
import { writeStderrSync } from "./writeStderrSync.js";

export function reportCliFailure(
    error: unknown,
    write: (text: string) => void = writeStderrSync,
): void {
    write(
        `${formatCliFailure(error, {
            color: supportsColor(),
            debug: process.argv.includes("--debug"),
        })}\n`,
    );
    process.exitCode = 1;
}

function supportsColor(): boolean {
    if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
    return process.stderr.isTTY === true;
}
