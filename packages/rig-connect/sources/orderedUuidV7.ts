export type RandomValues = (bytes: Uint8Array) => Uint8Array;

/**
 * Creates ordered UUIDv7 identities using only Web Crypto.
 *
 * The 12-bit sequence advances when the clock repeats or moves backwards. On
 * wrap the logical millisecond advances too, so identities from one client are
 * strictly ordered even under a render burst larger than one timestamp tick.
 */
export function orderedUuidV7(
    now: () => number = Date.now,
    randomValues: RandomValues = defaultRandomValues,
): () => string {
    let lastMilliseconds = -1;
    let sequence = 0;

    return () => {
        const random = randomValues(new Uint8Array(10));
        let milliseconds = Math.max(0, Math.floor(now()));
        if (milliseconds > lastMilliseconds) {
            sequence = ((random[0] ?? 0) << 4) | ((random[1] ?? 0) >>> 4);
        } else {
            milliseconds = lastMilliseconds;
            sequence += 1;
            if (sequence > 0x0fff) {
                milliseconds += 1;
                sequence = 0;
            }
        }
        lastMilliseconds = milliseconds;

        const bytes = new Uint8Array(16);
        let timestamp = milliseconds;
        for (let index = 5; index >= 0; index -= 1) {
            bytes[index] = timestamp % 256;
            timestamp = Math.floor(timestamp / 256);
        }
        bytes[6] = 0x70 | ((sequence >>> 8) & 0x0f);
        bytes[7] = sequence & 0xff;
        bytes[8] = 0x80 | ((random[2] ?? 0) & 0x3f);
        bytes.set(random.slice(3, 10), 9);

        const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    };
}

function defaultRandomValues(bytes: Uint8Array): Uint8Array {
    globalThis.crypto.getRandomValues(bytes as unknown as Uint8Array<ArrayBuffer>);
    return bytes;
}