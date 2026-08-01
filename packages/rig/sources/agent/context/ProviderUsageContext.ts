import type { ProviderUsageEntry } from "../../protocol/index.js";

export interface ProviderUsageContext {
    /** The latest usage reading Rig holds for every configured provider. */
    list(): readonly ProviderUsageEntry[];
}
