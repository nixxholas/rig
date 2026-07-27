import type { FileDiff, ToolCallPresentation, ToolResultPresentation } from "./protocol.js";

/**
 * One thing a tool looked at while exploring the workspace.
 *
 * This keeps the daemon's own semantics rather than turning them into a phrase.
 * Wording belongs to the interface: a sidebar, a transcript row, and a screen
 * reader all describe the same search differently, and none of them can recover
 * the query once it has been folded into a sentence.
 */
export type ExplorationStep =
    | { readonly kind: "list"; readonly target: string }
    | { readonly kind: "read"; readonly name: string }
    | {
          readonly kind: "search";
          /** The command that ran, kept for a UI that shows the literal search. */
          readonly command: string;
          readonly path?: string;
          readonly query?: string;
      };

/**
 * A command Rig ran, with its output as it arrives.
 *
 * The wire describes a running command and a finished one as two unrelated
 * shapes. They are the same thing to a reader, so they project to one value that
 * gains its output rather than being replaced by a different kind.
 */
export interface CommandPresentation {
    readonly kind: "command";
    readonly command: string;
    /** Absent while the command is still running. */
    readonly output?: string;
    /** Present when the command belongs to a background terminal. */
    readonly terminalId?: number;
}

export interface ExplorationPresentation {
    readonly kind: "exploration";
    readonly steps: readonly ExplorationStep[];
}

export interface FileEditPresentation {
    readonly kind: "file_edit";
    readonly files: readonly FileDiff[];
    /** Set when the daemon trimmed the list to keep the payload bounded. */
    readonly omittedFiles?: number;
}

/** Input a person or the agent sent to a terminal that was already running. */
export interface TerminalInputPresentation {
    readonly kind: "terminal_input";
    readonly command: string;
    readonly input: string;
    readonly terminalId: number;
}

/**
 * What a tool call is doing, in application terms.
 *
 * This is a closed union on purpose. A consumer narrows on `kind` and never
 * needs to know how Rig encodes presentation on the wire, which is the whole
 * reason the projection exists. A kind this library does not know projects to
 * `undefined`, and the call's plain `result` text remains the fallback.
 */
export type ToolPresentation =
    | CommandPresentation
    | ExplorationPresentation
    | FileEditPresentation
    | TerminalInputPresentation;

/**
 * Turns Rig's wire presentation into one application value.
 *
 * Both halves are taken together because a call and its result describe the same
 * work at two moments. The result wins where they overlap, since it is the later
 * and more complete account.
 */
export function projectToolPresentation(
    call: ToolCallPresentation | undefined,
    result: ToolResultPresentation | undefined,
): ToolPresentation | undefined {
    if (result !== undefined) {
        switch (result.type) {
            case "exec_command":
                return {
                    command: result.command,
                    kind: "command",
                    output: result.output,
                    ...(result.sessionId === undefined ? {} : { terminalId: result.sessionId }),
                };
            case "background_terminal_interaction":
                return {
                    command: result.command,
                    input: result.input,
                    kind: "terminal_input",
                    terminalId: result.sessionId,
                };
            case "file_diff":
                return {
                    files: result.files,
                    kind: "file_edit",
                    ...(result.omittedFiles === undefined
                        ? {}
                        : { omittedFiles: result.omittedFiles }),
                };
        }
    }

    if (call !== undefined) {
        switch (call.type) {
            case "exec_command":
                // No output yet: the same value the finished call will carry,
                // so a UI does not swap one shape for another mid-flight.
                return { command: call.command, kind: "command" };
            case "exploration":
                // The operations are already application-shaped, so they pass
                // through unchanged.
                return { kind: "exploration", steps: call.operations };
        }
    }

    return undefined;
}
