import { createRootContext, forever as repeat, withLifetime } from "@steve.kite/stdlib";

export interface ForeverOptions {
    delay: number;
    name: string;
    signal: AbortSignal;
    delayFirst?: boolean;
    onError?: (error: unknown, attempt: number) => void;
}

/** Context-adapted stdlib background loop. */
export async function forever(options: ForeverOptions, work: () => Promise<void>): Promise<void> {
    const ctx = withLifetime(createRootContext(), options.signal);
    await repeat(ctx, {
        delay: options.delay,
        name: options.name,
        ...(options.delayFirst === undefined ? {} : { delayFirst: options.delayFirst }),
        ...(options.onError === undefined
            ? {}
            : { onError: (_ctx, error, attempt) => options.onError!(error, attempt) }),
    }, async () => await work());
}
