import type { ToolResultPresentation } from "./ToolResultPresentation.js";

export const TOOL_RESULT_PRESENTATION_MAXIMUM_OUTPUT_CHARACTERS = 3_000;
export const TOOL_RESULT_PRESENTATION_TRUNCATION_NOTICE = "[Command output truncated]\n";
export const TOOL_RESULT_PRESENTATION_RETAINED_OUTPUT_CHARACTERS =
    TOOL_RESULT_PRESENTATION_MAXIMUM_OUTPUT_CHARACTERS -
    Array.from(TOOL_RESULT_PRESENTATION_TRUNCATION_NOTICE).length;

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
            ...notice,
            ...characters.slice(-TOOL_RESULT_PRESENTATION_RETAINED_OUTPUT_CHARACTERS),
        ].join(""),
    };
}
