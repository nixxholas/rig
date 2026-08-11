import type { ToolResultPresentation } from "../ToolResultPresentation.js";

export const TOOL_RESULT_PRESENTATION_MAXIMUM_OUTPUT_CHARACTERS = 3_000;
export const TOOL_RESULT_PRESENTATION_TRUNCATION_NOTICE = "[Command output truncated]\n";
export const TOOL_RESULT_PRESENTATION_RETAINED_OUTPUT_CHARACTERS =
    TOOL_RESULT_PRESENTATION_MAXIMUM_OUTPUT_CHARACTERS -
    Array.from(TOOL_RESULT_PRESENTATION_TRUNCATION_NOTICE).length;
export const TOOL_RESULT_PRESENTATION_RETAINED_OUTPUT_HEAD_CHARACTERS = Math.ceil(
    TOOL_RESULT_PRESENTATION_RETAINED_OUTPUT_CHARACTERS / 2,
);
export const TOOL_RESULT_PRESENTATION_RETAINED_OUTPUT_TAIL_CHARACTERS =
    TOOL_RESULT_PRESENTATION_RETAINED_OUTPUT_CHARACTERS -
    TOOL_RESULT_PRESENTATION_RETAINED_OUTPUT_HEAD_CHARACTERS;

export function boundToolResultPresentation(
    presentation: ToolResultPresentation | undefined,
): ToolResultPresentation | undefined {
    if (presentation?.type !== "exec_command") return presentation;
    const characters = Array.from(presentation.output);
    if (characters.length <= TOOL_RESULT_PRESENTATION_MAXIMUM_OUTPUT_CHARACTERS) {
        return presentation;
    }

    const notice = Array.from(TOOL_RESULT_PRESENTATION_TRUNCATION_NOTICE);
    return {
        ...presentation,
        output: [
            ...characters.slice(0, TOOL_RESULT_PRESENTATION_RETAINED_OUTPUT_HEAD_CHARACTERS),
            ...notice,
            ...characters.slice(-TOOL_RESULT_PRESENTATION_RETAINED_OUTPUT_TAIL_CHARACTERS),
        ].join(""),
    };
}
