import { agentPermissionModeLabel, type AgentPermissionMode } from "@slopus/happy-agent-base";

/**
 * What the model is told when a tool cannot be contained by the mode in force. The tool is not
 * refused for this call; it is unavailable until somebody changes the mode, and saying so is what
 * stops a turn spending itself trying the same thing from a different angle.
 */
export function outOfModeRefusal(tool: string, mode: AgentPermissionMode): string {
    return (
        `The tool "${tool}" acts outside the sandbox, so it is unavailable in ` +
        `${agentPermissionModeLabel(mode)} mode. No form of this call will run while the mode ` +
        "stands. Continue with what you can do here, or stop and explain what the work needs."
    );
}

/** What the model is told when the reviewer decided this action must not happen. */
export function deniedRefusal(action: string, reason: string): string {
    return (
        `This action was reviewed and refused: ${action}\n\nReason: ${reason}\n\n` +
        "The decision is final and covers this action however it is phrased. Continue only with " +
        "a materially safer alternative, or stop and explain yourself so the person can decide."
    );
}

/**
 * What the model is told when the review never happened. This is the absence of a decision rather
 * than a refusal, and the difference is what the model is meant to act on: nothing has judged the
 * action unsafe, so it is unproven, and the answer is to say so rather than to find another route.
 */
export function unprovenRefusal(action: string, reason: string): string {
    return (
        `This action could not be reviewed, so it did not run: ${action}\n\nWhat happened: ` +
        `${reason}\n\nNothing decided that the action is unsafe — it is unproven. Do not attempt ` +
        "the same thing another way. Say what you were trying to do and what stopped you."
    );
}

/** What the model is told when refusal after refusal has ended its turn. */
export function turnStoppedNotice(refusals: number): string {
    return (
        `This turn has been stopped after ${refusals} refused actions in a row. Nothing else ` +
        "will run in it. The person has to decide what happens next."
    );
}
