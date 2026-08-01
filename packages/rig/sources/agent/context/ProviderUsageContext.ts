import type { ProviderUsageEntry } from "../../protocol/index.js";

export interface ProviderUsageContext {
    /**
     * The most recent usage reading Rig can offer for every configured
     * provider. Asking may refresh a reading that has grown old, but never
     * more often than the vendor tolerates, so it is always safe to call.
     */
    current(): Promise<readonly ProviderUsageEntry[]>;
}
