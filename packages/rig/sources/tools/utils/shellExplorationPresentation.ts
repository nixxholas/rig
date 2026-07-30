import type { ExplorationToolCallPresentation } from "../../agent/ToolCallPresentation.js";
import { parseShellExplorationPresentation } from "./parseShellExplorationPresentation.js";

/**
 * The exploration presentation a shell command keeps from its call to its result.
 *
 * A command that only inspects the workspace belongs in the exploration block,
 * and it has to stay there once it finishes. A result that fell back to the
 * generic command shape would rewrite a row the reader is already looking at, so
 * the call and the result ask the same question with the same answer. A command
 * that leaves a background terminal behind is the one exception: the terminal is
 * a new thing the reader can act on, and it needs the command shape to show it.
 */
export function shellExplorationPresentation(options: {
    background?: boolean;
    command: string;
    sessionId?: number;
}): ExplorationToolCallPresentation | undefined {
    if (options.background === true || options.sessionId !== undefined) return undefined;
    return parseShellExplorationPresentation(options.command);
}
