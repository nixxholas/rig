import { createRootContext, delay as wait, withLifetime } from "@steve.kite/stdlib";

/** Waits through stdlib's context-aware delay while preserving Rig's signal-shaped API. */
export async function delay(ms: number, signal?: AbortSignal): Promise<void> {
    const ctx = signal === undefined ? createRootContext() : withLifetime(createRootContext(), signal);
    await wait(ctx, ms);
}
