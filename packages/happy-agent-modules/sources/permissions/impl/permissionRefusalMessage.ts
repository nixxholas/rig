import { agentPermissionModeLabel, type AgentPermissionMode } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

export const MAX_PERMISSION_REFUSAL_CHARACTERS = 16_384;
export const MAX_PERMISSION_ERROR_CHARACTERS = 1_024;

export const permissionUnprovenKindSchema = Type.Union([
    Type.Literal("timed_out"),
    Type.Literal("unavailable"),
]);

export type PermissionUnprovenKind = Static<typeof permissionUnprovenKindSchema>;

/**
 * What the model is told when a tool cannot be contained by the mode in force. The tool is not
 * refused for this call; it is unavailable until somebody changes the mode, and saying so is what
 * stops a turn spending itself trying the same thing from a different angle.
 */
export function outOfModeRefusal(tool: string, mode: AgentPermissionMode): string {
    return boundRefusal(
        `The tool "${tool}" acts outside the sandbox, so it is unavailable in ` +
            `${agentPermissionModeLabel(mode)} mode. No form of this call will run while the mode ` +
            "stands. Continue with what you can do here, or stop and explain what the work needs.",
    );
}

/** What the model is told when a reviewable tool forgot to define its action boundary. */
export function missingPermissionActionRefusal(tool: string): string {
    return boundRefusal(
        `This tool cannot request Auto approval because its permission action is not defined ` +
            `("${tool}"). The call was refused as a tool-definition error. Do not retry it; the tool ` +
            "definition must be corrected first.",
    );
}

/** What the model is told when the tool's review request cannot satisfy the bounded contract. */
export function permissionRequestRefusal(tool: string, reason: string): string {
    return boundRefusal(
        `The tool "${tool}" could not be reviewed because its permission request is invalid. ` +
            `${reason} The call did not run; correct the tool request before trying again.`,
    );
}

/** What the model is told when the reviewer decided this action must not happen. */
export function deniedRefusal(action: string, reason: string): string {
    return boundRefusal(
        `This action was reviewed and refused: ${action}\n\nReason: ${reason}\n\n` +
            "The decision is final and covers this action however it is phrased. Continue only with " +
            "a materially safer alternative, or stop and explain yourself so the person can decide.",
    );
}

/**
 * What the model is told when the review never happened. This is the absence of a decision rather
 * than a refusal, and the difference is what the model is meant to act on: nothing has judged the
 * action unsafe, so it is unproven, and the answer is to say so rather than to find another route.
 */
export function unprovenRefusal(
    action: string,
    reason: string,
    kind: PermissionUnprovenKind = "unavailable",
): string {
    if (kind === "timed_out") {
        return boundRefusal(
            `This action could not be reviewed in time, so it did not run: ${action}\n\nWhat ` +
                `happened: ${reason}\n\nNothing decided that the action is unsafe — it is unproven. ` +
                "You may try once more, or ask the user how to proceed.",
        );
    }
    return boundRefusal(
        `This action could not be reviewed because no reliable reviewer answer was available, so ` +
            `it did not run: ${action}\n\nWhat happened: ${reason}\n\nNothing decided that the action ` +
            "is unsafe — it is unproven. Continue with work that does not need this permission, or " +
            "ask the user how to proceed.",
    );
}

/** What the model is told when refusal after refusal has ended its turn. */
export function turnStoppedNotice(consecutive: number, recent = consecutive): string {
    return boundRefusal(
        `This turn has been stopped after too many refused actions (${consecutive} in a row, ` +
            `${recent} of the last 50). Nothing else will run in it. The person has to decide what ` +
            "happens next.",
    );
}

function boundRefusal(message: string): string {
    if (message.length <= MAX_PERMISSION_REFUSAL_CHARACTERS) return message;
    const marker = "\n\n[Permission refusal truncated.]";
    return `${message.slice(0, MAX_PERMISSION_REFUSAL_CHARACTERS - marker.length)}${marker}`;
}
