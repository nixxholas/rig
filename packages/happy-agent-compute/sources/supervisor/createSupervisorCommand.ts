import type { SupervisorPolicy } from "@slopus/happy-agent-supervisor";

/** A direct supervisor invocation with the policy carried as an ordinary argument. */
export interface SupervisorCommand {
    args: readonly string[];
    command: string;
}

export function createSupervisorCommand(options: {
    command: string;
    policy: SupervisorPolicy;
    shell: string;
    supervisorPath: string;
}): SupervisorCommand {
    return {
        args: [
            "--policy",
            JSON.stringify(options.policy),
            "--",
            options.shell,
            "-lc",
            options.command,
        ],
        command: options.supervisorPath,
    };
}
