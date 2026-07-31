import type { AnyDefinedTool } from "../agent/types.js";
import { scheduleMessageTool, waitTool, waitUntilTool } from "../scheduling/index.js";

export function selectCommonToolsForModel(options: {
    isSubagent: boolean;
}): readonly AnyDefinedTool[] {
    return [
        waitTool,
        waitUntilTool,
        ...(options.isSubagent ? [] : [scheduleMessageTool]),
    ] as readonly AnyDefinedTool[];
}
