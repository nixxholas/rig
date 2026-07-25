import type { SessionContext } from "@/core/SessionContext.js";
import type { SessionTool } from "@/core/SessionTool.js";

/** Model-visible configuration supplied up front for a model used by the session. */
export interface SessionModelConfiguration {
    readonly context: SessionContext;
    readonly tools?: readonly SessionTool[];
}
