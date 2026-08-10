import { basename } from "node:path";
import type { Context } from "@steve.kite/stdlib";

import { createShellEnvironment } from "../agent/context/createShellEnvironment.js";
import { NativeProcessManager, resolveSystemShell } from "../processes/index.js";

const WORKSPACE_SETUP_COMMAND_TIMEOUT_MS = 30 * 60 * 1_000;
const WORKSPACE_SETUP_OUTPUT_LIMIT = 512 * 1_024;
const WORKSPACE_SETUP_ERROR_OUTPUT_LIMIT = 300;

export interface RunWorkspaceSetupCommandsOptions {
    environment?: NodeJS.ProcessEnv;
    processManager?: NativeProcessManager;
    signal?: AbortSignal;
}

export async function runWorkspaceSetupCommands(
    ctx: Context,
    cwd: string,
    commands: readonly string[],
    options: RunWorkspaceSetupCommandsOptions = {},
): Promise<void> {
    if (commands.length === 0) return;
    const environment = options.environment ?? process.env;
    const processManager = options.processManager ?? new NativeProcessManager();
    const shell = resolveSystemShell(environment);

    for (const [index, command] of commands.entries()) {
        options.signal?.throwIfAborted();
        const result = await processManager.run(ctx, {
            args: shellArgs(shell, command),
            command: shell,
            cwd,
            env: createShellEnvironment(environment),
            maxOutputBytes: WORKSPACE_SETUP_OUTPUT_LIMIT,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            timeoutMs: WORKSPACE_SETUP_COMMAND_TIMEOUT_MS,
        });
        if (result.aborted) {
            throw options.signal?.reason ?? new Error("Workspace setup was stopped.");
        }
        if (result.exitCode === 0 && !result.timedOut) continue;

        const number = index + 1;
        const status = result.timedOut
            ? `timed out after ${String(WORKSPACE_SETUP_COMMAND_TIMEOUT_MS / 60_000)} minutes`
            : `failed with exit code ${String(result.exitCode)}`;
        const output = tail(`${result.stdout}${result.stderr}`, WORKSPACE_SETUP_ERROR_OUTPUT_LIMIT);
        throw new Error(
            [
                `Workspace setup command ${String(number)} ${status}.`,
                ...(output.length === 0 ? [] : [output]),
                `Command: ${command}`,
            ].join("\n"),
        );
    }
}

function shellArgs(shell: string, command: string): string[] {
    if (process.platform !== "win32") return ["-lc", command];
    const name = basename(shell).toLowerCase();
    return name === "cmd.exe" || name === "cmd" ? ["/d", "/s", "/c", command] : ["-c", command];
}

function tail(value: string, limit: number): string {
    const normalized = value.trim();
    return normalized.length <= limit ? normalized : `…${normalized.slice(-limit)}`;
}
