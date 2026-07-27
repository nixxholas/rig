export function parseOptionalTerminalSessionId(taskId: string | undefined): number | undefined {
    if (taskId === undefined || !/^(?:0|[1-9]\d*)$/.test(taskId)) return undefined;
    const sessionId = Number(taskId);
    return Number.isSafeInteger(sessionId) && sessionId >= 0 ? sessionId : undefined;
}
