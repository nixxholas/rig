import type { RandomValues } from "./orderedUuidV7.js";

const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";
const LETTERS = "abcdefghijklmnopqrstuvwxyz";
/** The cuid2 default. A daemon accepts 2 to 32 characters. */
const LENGTH = 24;
const TIME_LENGTH = 8;
const COUNTER_LENGTH = 3;
const RANDOM_LENGTH = LENGTH - 1 - TIME_LENGTH - COUNTER_LENGTH;
const COUNTER_LIMIT = 36 ** COUNTER_LENGTH;

/**
 * Creates cuid2 identities using only Web Crypto.
 *
 * A client names what it creates, so these identities have to be unique against
 * every other client without asking anyone. The clock and the counter make two
 * ids from one process differ even where the random source is weak or stubbed,
 * and the random tail is what separates two processes that start together.
 */
export function createCuid2(
    now: () => number = Date.now,
    randomValues: RandomValues = defaultRandomValues,
): () => string {
    let counter = 0;

    return () => {
        const random = randomValues(new Uint8Array(RANDOM_LENGTH + 1));
        counter = (counter + 1) % COUNTER_LIMIT;
        const time = Math.max(0, Math.floor(now()))
            .toString(36)
            .slice(-TIME_LENGTH)
            .padStart(TIME_LENGTH, "0");
        const count = counter.toString(36).padStart(COUNTER_LENGTH, "0");
        let tail = "";
        for (let index = 0; index < RANDOM_LENGTH; index += 1) {
            tail += DIGITS[(random[index + 1] ?? 0) % 36];
        }
        // A cuid2 always opens with a letter.
        return `${LETTERS[(random[0] ?? 0) % 26] ?? "a"}${time}${count}${tail}`;
    };
}

function defaultRandomValues(bytes: Uint8Array): Uint8Array {
    globalThis.crypto.getRandomValues(bytes as unknown as Uint8Array<ArrayBuffer>);
    return bytes;
}
