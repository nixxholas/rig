import type { AgentFeature, AgentFeatureScope, AnyAgentTool } from "@slopus/happy-agent-base";
import { mapAsyncLock, type Context, type MapAsyncLock } from "@steve.kite/stdlib";

import type { Compute, ComputeSessionActivity, ComputeSessionSnapshot } from "./Compute.js";
import { FileReadLog } from "./impl/FileReadLog.js";
import { editFileTool } from "./tools/edit_file.js";
import { findFilesTool } from "./tools/find_files.js";
import { listDirectoryTool } from "./tools/list_directory.js";
import { readCommandOutputTool } from "./tools/read_command_output.js";
import { readFileTool } from "./tools/read_file.js";
import { runCommandTool } from "./tools/run_command.js";
import { searchFilesTool } from "./tools/search_files.js";
import { sendCommandInputTool } from "./tools/send_command_input.js";
import { stopCommandTool } from "./tools/stop_command.js";
import { writeFileTool } from "./tools/write_file.js";

/** What a compute feature is built with. */
export interface ComputeFeatureOptions {
    /** The machine the agent works on: its filesystem, its shell, and the boundary over both. */
    readonly compute: Compute;
}

/**
 * A machine to work on, as ten tools over one compute.
 *
 * Files are read, written, edited, listed, found by name, and searched by content; commands are
 * run, left running, read, typed into, and stopped. They are common Rig tools rather than any
 * vendor's, so every model gets exactly these, under these names, with these arguments.
 *
 * Two things here are worth knowing before changing them. Reading a file is what earns the right
 * to change it: each agent's reads are remembered in its own store, and a write or an edit to a
 * file this agent never read — or read before somebody else changed it — is refused rather than
 * quietly discarding that work. And a command that outlives its wait is not killed: it goes on
 * running with an ID the model comes back to, which is what makes a dev server started in one
 * turn still be serving in the next.
 *
 * One instance serves every agent in a collection: the machine is shared, and the only per-agent
 * state is the log of what that agent has read, which lives in the store the agent lends the
 * feature. The compute is not the feature's to dispose of. Commands left running belong to the
 * compute, and disposing that compute is what ends them — the feature never does, not when a turn
 * is cancelled and not when an agent settles.
 */
export class ComputeFeature implements AgentFeature {
    readonly name = "compute";

    /** The machine every tool acts on. */
    readonly #compute: Compute;
    /**
     * One lock per agent, so two tool calls in the same turn recording what they read do not
     * decide from the same reading of the log. Agents are independent and never wait on one
     * another.
     */
    readonly #readLocks: MapAsyncLock<string> = mapAsyncLock<string>();

    constructor(options: ComputeFeatureOptions) {
        this.#compute = options.compute;
    }

    /**
     * The commands running right now, for a person looking at what an agent has left behind. A
     * machine that does not offer the list simply has none to show.
     */
    runningCommands(): readonly ComputeSessionActivity[] {
        return this.#compute.shell.activeSessions?.() ?? [];
    }

    /**
     * What one command has produced, without consuming it. The cursor into a command's output
     * belongs to the agent, so a person watching a command must not take output the model has
     * not been given yet.
     */
    async readCommand(commandId: number): Promise<ComputeSessionSnapshot | undefined> {
        return await this.#compute.shell.readSession(commandId, { peek: true });
    }

    /** Stop a command by hand. Answers whether there was one still running to stop. */
    async stopCommand(commandId: number): Promise<boolean> {
        return (await this.#compute.shell.killSession(commandId)) !== undefined;
    }

    /**
     * What the model has to be told that the tool descriptions cannot say on their own: where it
     * is, and how the two rules above will behave when it meets them.
     */
    readonly instructions = (): string =>
        [
            `You are working on a machine whose working directory is ${this.#compute.cwd}. Paths that are not absolute are relative to it.`,
            "Read a file before changing it. write_file and edit_file refuse a file you have not read, and refuse one that changed on disk after you read it; read it again and reconsider the change.",
            "A command that outlives its timeout is not killed. It keeps running and comes back with a command ID, and every later read of it returns only what is new.",
        ].join("\n");

    readonly tools = (_ctx: Context, scope: AgentFeatureScope): readonly AnyAgentTool[] => {
        const reads = new FileReadLog(scope.kv, this.#readLocks, scope.agent.id);
        return [
            readFileTool(this.#compute, reads),
            writeFileTool(this.#compute, reads),
            editFileTool(this.#compute, reads),
            listDirectoryTool(this.#compute),
            findFilesTool(this.#compute),
            searchFilesTool(this.#compute),
            runCommandTool(this.#compute),
            readCommandOutputTool(this.#compute),
            sendCommandInputTool(this.#compute),
            stopCommandTool(this.#compute),
        ];
    };
}
