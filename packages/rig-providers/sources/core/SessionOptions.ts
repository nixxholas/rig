import type { SessionModelConfiguration } from "@/core/SessionModelConfiguration.js";
import type { SessionToolsOptions } from "@/core/SessionTool.js";

/**
 * Immutable model-visible configuration for a session.
 *
 * A session is created from instructions and tools only. Conversation history belongs to the
 * caller, which supplies the complete transcript with every run and compaction; sessions never
 * receive initial messages at creation.
 */
export interface SessionOptions extends SessionToolsOptions {
    readonly instructions: string;
    /**
     * Alternate model-visible configurations supplied when a session can switch between
     * models whose instructions or tools differ.
     */
    readonly modelConfigurations?: Readonly<Record<string, SessionModelConfiguration>>;
}
