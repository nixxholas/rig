export function formatSessionTransferFailureNotice(input: {
    errorMessage: string;
    workspacePath: string;
}): string {
    return [
        "<session-transfer-failure-notice>",
        "The scheduled session transfer FAILED.",
        `This session remains in workspace ${input.workspacePath}.`,
        `Reason: ${input.errorMessage}`,
        "</session-transfer-failure-notice>",
    ].join("\n");
}
