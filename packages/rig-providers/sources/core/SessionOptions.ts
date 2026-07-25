import type { SessionContext } from "@/core/SessionContext.js";
import type { SessionModelConfiguration } from "@/core/SessionModelConfiguration.js";
import type { SessionToolsOptions } from "@/core/SessionTool.js";

/** Immutable model-visible configuration and initial history for a session. */
export interface SessionOptions extends SessionToolsOptions {
    readonly context: SessionContext;
    /**
     * Alternate model-visible configurations supplied when a session can switch between
     * models whose instructions or tools differ.
     */
    readonly modelConfigurations?: Readonly<Record<string, SessionModelConfiguration>>;
}
