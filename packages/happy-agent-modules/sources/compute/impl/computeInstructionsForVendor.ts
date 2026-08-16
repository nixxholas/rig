import type { ComputeToolVendor } from "../ComputeToolVendor.js";

/**
 * What the agent is told about the machine, in the names its own tools actually have.
 *
 * The two rules worth stating are the same everywhere — read a file before changing it, and a
 * command that outlives its wait keeps running — but a rule that names a tool the model does not
 * have is worse than no rule at all, so each vendor is told them in its own vocabulary.
 */
export function computeInstructionsForVendor(vendor: ComputeToolVendor): string {
    return instructionsByVendor[vendor];
}

const instructionsByVendor: Readonly<Record<ComputeToolVendor, string>> = Object.freeze({
    claude: [
        "Read a file before changing it. Write and Edit refuse a file you have not read, and refuse one that changed on disk after you read it; read it again and reconsider the change.",
        "A command that outlives its timeout is not killed. It keeps running and comes back with a shell ID, and every later BashOutput of it returns only what is new.",
    ].join("\n"),
    codex: [
        "Read a file before changing it. apply_patch refuses a file you have not read, and refuses one that changed on disk after you read it; read it again and reconsider the change.",
        "A command that outlives its yield time is not killed. It keeps running and comes back with a session ID, and every later write_stdin poll of it returns only what is new.",
    ].join("\n"),
    grok: [
        "Read a file before changing it. write and search_replace refuse a file you have not read, and refuse one that changed on disk after you read it; read it again and reconsider the change.",
        "A command that outlives its timeout is not killed. It keeps running and comes back with a task ID, and every later get_command_or_subagent_output of it returns only what is new.",
    ].join("\n"),
});
