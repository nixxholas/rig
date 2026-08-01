import type { ProviderUsage, ProviderUsageEntry } from "./protocol.js";

export type { ProviderUsage, ProviderUsageEntry };

/**
 * Where the usage subscription is in its own cycle.
 *
 * Usage is polled rather than streamed, so a view has to be able to tell "we
 * have not asked yet" from "we asked and the answer is that nothing is known".
 * `loading` is only ever true before the first answer arrives; a later refresh
 * keeps showing the readings it already has.
 */
export interface ProviderUsageState {
    readonly loading: boolean;
    /** When the last successful read finished, in milliseconds. */
    readonly loadedAt: number | null;
    /** Why the last attempt failed, when it failed. Readings stay usable. */
    readonly error: string | null;
}

export type ProviderUsageDelta =
    | { readonly providers: readonly ProviderUsageEntry[]; readonly type: "providers_changed" }
    | { readonly state: ProviderUsageState; readonly type: "provider_usage_state_changed" };
