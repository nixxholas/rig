import {
    BoundedProcessLog,
    MAXIMUM_PROCESS_LOG_STORAGE_BYTES,
} from "../utils/BoundedProcessLog.js";

export const MAXIMUM_PLUGIN_LOG_STORAGE_BYTES = MAXIMUM_PROCESS_LOG_STORAGE_BYTES;

const TRUNCATION_NOTICE = "[Earlier plugin output omitted.]\n";

/** Keeps one coalesced, bounded tail of the current plugin process. */
export class PluginLog extends BoundedProcessLog {
    constructor(options: { initialContent?: Buffer; maximumBytes?: number; path: string }) {
        super({ ...options, truncationNotice: TRUNCATION_NOTICE });
    }
}
