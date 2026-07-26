import { RigUserError } from "../RigUserError.js";

export interface SessionCommandOptions {
    all: boolean;
    last: boolean;
    sessionId?: string;
}

export function parseSessionCommand(args: readonly string[]): SessionCommandOptions {
    const options: SessionCommandOptions = { all: false, last: false };
    for (const arg of args) {
        if (arg === "--all") {
            options.all = true;
        } else if (arg === "--last") {
            options.last = true;
        } else if (arg.startsWith("-")) {
            throw new RigUserError(`Rig does not understand the option '${arg}'.`, {
                hint: "Session commands accept --all and --last.",
            });
        } else if (options.sessionId === undefined) {
            options.sessionId = arg;
        } else {
            throw new RigUserError("Rig can only resume one session at a time.", {
                hint: "Pass a single session identifier.",
            });
        }
    }
    if (options.last && options.sessionId !== undefined) {
        throw new RigUserError("Rig cannot use --last together with a session identifier.", {
            hint: "Choose one of them.",
        });
    }
    return options;
}
