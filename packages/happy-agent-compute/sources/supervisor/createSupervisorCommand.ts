import type { SupervisorPolicy } from "@slopus/happy-agent-supervisor";

/**
 * A supervisor invocation whose policy travels over stdin rather than through a mutable file or
 * process arguments. The wrapper reads exactly one JSON line, then gives the remaining stdin to the
 * workload unchanged.
 */
export interface SupervisorCommand {
    args: readonly string[];
    command: string;
    initialStdin: string;
    initialStdinHandshake: {
        completeMarker: string;
        readyMarker: string;
    };
}

export interface DirectSupervisorCommand {
    args: readonly string[];
    command: string;
    extraFileDescriptorInputs: readonly string[];
}

const READY_MARKER = "\u001ehappy-agent-supervisor-policy-ready\u001f";
const COMPLETE_MARKER = "\u001ehappy-agent-supervisor-policy-complete\u001f";

export function createSupervisorCommand(options: {
    command: string;
    policy: SupervisorPolicy;
    shell: string;
    supervisorPath: string;
}): SupervisorCommand {
    return {
        args: [
            "-c",
            SUPERVISOR_COMMAND_SCRIPT,
            "happy-agent-supervisor",
            options.supervisorPath,
            READY_MARKER,
            COMPLETE_MARKER,
            options.shell,
            "-lc",
            options.command,
        ],
        command: "/bin/sh",
        initialStdin: `${JSON.stringify(options.policy)}\n`,
        initialStdinHandshake: {
            completeMarker: COMPLETE_MARKER,
            readyMarker: READY_MARKER,
        },
    };
}

/** A direct supervisor spawn with policy JSON on inherited descriptor 3. */
export function createDirectSupervisorCommand(options: {
    command: string;
    policy: SupervisorPolicy;
    shell: string;
    supervisorPath: string;
}): DirectSupervisorCommand {
    return {
        args: ["--policy-fd", "3", "--", options.shell, "-lc", options.command],
        command: options.supervisorPath,
        extraFileDescriptorInputs: [JSON.stringify(options.policy)],
    };
}

const SUPERVISOR_COMMAND_SCRIPT = String.raw`
supervisor=$1
ready_marker=$2
complete_marker=$3
shift 3
if [ -t 0 ]; then
    terminal_state=$(stty -g) || exit 125
    stty -echo -icanon min 1 time 0 || exit 125
    printf %s "$ready_marker"
    terminal_input=1
fi
IFS= read -r policy_json || exit 125
if [ "$terminal_input" = 1 ]; then
    stty "$terminal_state" || exit 125
    printf %s "$complete_marker"
fi
exec 4<&0 || exit 125
printf %s "$policy_json" | "$supervisor" --policy-fd 3 3<&0 0<&4 4>&- -- "$@"
exit $?
`;
