import type { SupervisorPolicy } from "@slopus/happy-agent-supervisor";

import {
    createSupervisorCommand,
    type SupervisorCommand,
} from "../../supervisor/createSupervisorCommand.js";

/** The fixed read-only mount used by managed and explicitly prepared containers. */
export const DOCKER_SUPERVISOR_PATH = "/tools/happy-agent-sandbox";

/**
 * Creates the in-container command that sends one command-scoped policy over a private pipe to the
 * mounted native supervisor. The wrapper preserves the workload's stdin on a separate descriptor,
 * so no mutable policy file or process argument contains the policy.
 */
export function createDockerSupervisorCommand(options: {
    command: string;
    policy: SupervisorPolicy;
    shell: string;
    supervisorPath?: string;
}): SupervisorCommand {
    return createSupervisorCommand({
        command: options.command,
        policy: options.policy,
        shell: options.shell,
        supervisorPath: options.supervisorPath ?? DOCKER_SUPERVISOR_PATH,
    });
}
