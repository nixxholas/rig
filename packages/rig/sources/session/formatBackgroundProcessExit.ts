import type { BashSessionExit } from "../agent/context/BashContext.js";

/**
 * Says that a background command ended, and nothing else.
 *
 * The output stays where it is; the model reads it when it wants it.
 */
export function formatBackgroundProcessExit(exit: BashSessionExit): string {
    const ending =
        exit.status === "killed"
            ? "was stopped"
            : exit.exitCode === 0
              ? "finished successfully"
              : exit.exitCode === null
                ? "ended"
                : `failed with exit code ${String(exit.exitCode)}`;
    return `Background command ${String(exit.sessionId)} (${exit.command}) ${ending}. Its remaining output is still available to read.`;
}
