import { Type, type Static } from "@sinclair/typebox";

/**
 * How much of a tool's work an owner replicates to the friends they shared with.
 *
 * `summaries` is the default and the only setting a share can have without the
 * owner asking for more. It replicates what the agent did and how it turned out
 * — the file it read, the command it ran, the exit code it came back with — and
 * keeps the payload on the owner's machine.
 *
 * `full` additionally replicates the raw arguments and raw output of the tools
 * that declared themselves disclosable. It is never all tools: a tool opts into
 * being disclosable, so raising this setting cannot reach a tool whose result is
 * sensitive by nature. Revocation cannot erase what a member already received,
 * so this is a decision about every tool call still to come, not a view toggle.
 */
export const sharedToolOutputSchema = Type.Union([Type.Literal("summaries"), Type.Literal("full")]);
export type SharedToolOutput = Static<typeof sharedToolOutputSchema>;

export const DEFAULT_SHARED_TOOL_OUTPUT: SharedToolOutput = "summaries";

/** Reads a stored or received setting, treating anything unrecognized as private. */
export function toSharedToolOutput(value: unknown): SharedToolOutput {
    return value === "full" ? "full" : DEFAULT_SHARED_TOOL_OUTPUT;
}

/** Human-readable description of what a share currently replicates. */
export function describeSharedToolOutput(toolOutput: SharedToolOutput): string {
    return toolOutput === "full"
        ? "Friends see what each tool did and the output it produced."
        : "Friends see what each tool did, without the output it produced.";
}
