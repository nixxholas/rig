import type { AnyAgentTool } from "@slopus/happy-agent-base";

import type { Compute } from "../../Compute.js";
import type { FileReadLog } from "../../../impl/FileReadLog.js";
import { claudeBashTool } from "./Bash.js";
import { claudeBashInputTool } from "./BashInput.js";
import { claudeBashOutputTool } from "./BashOutput.js";
import { claudeBashStopTool } from "./BashStop.js";
import { claudeEditTool } from "./Edit.js";
import { claudeGlobTool } from "./Glob.js";
import { claudeGrepTool } from "./Grep.js";
import { claudeReadTool } from "./Read.js";
import { claudeWriteTool } from "./Write.js";

/**
 * The machine as a Claude model expects to find it.
 *
 * The array is fixed and written in Claude's own order, because the order a model was trained to
 * see its tools in is part of that surface. Nothing here filters, detects, or reorders.
 */
export function assembleClaudeComputeTools(
    compute: Compute,
    reads: FileReadLog,
): readonly AnyAgentTool[] {
    return [
        claudeBashOutputTool(compute),
        claudeBashTool(compute),
        claudeReadTool(compute, reads),
        claudeEditTool(compute, reads),
        claudeWriteTool(compute, reads),
        claudeGlobTool(compute),
        claudeGrepTool(compute),
        claudeBashStopTool(compute),
        claudeBashInputTool(compute),
    ];
}
