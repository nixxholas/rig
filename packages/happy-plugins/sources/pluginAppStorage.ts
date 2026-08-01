import { HAPPY_PLUGIN_MAX_STORAGE_VALUE_BYTES, HAPPY_PLUGIN_MAX_STORAGE_BYTES } from "./types.js";

const STORAGE_KEY = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;

export function assertHappyPluginStorageKey(key: string): void {
    if (!STORAGE_KEY.test(key)) {
        throw new Error("Storage keys must be safe lowercase IDs.");
    }
}

export function encodeHappyPluginStorageValue(value: unknown): string {
    let encoded: string | undefined;
    try {
        encoded = JSON.stringify(value);
    } catch {
        encoded = undefined;
    }
    if (encoded === undefined) {
        throw new Error("Storage values must be JSON serializable.");
    }
    const body = `${encoded}\n`;
    if (Buffer.byteLength(body) > HAPPY_PLUGIN_MAX_STORAGE_VALUE_BYTES) {
        throw new Error(
            `A storage value cannot exceed ${String(HAPPY_PLUGIN_MAX_STORAGE_VALUE_BYTES)} bytes.`,
        );
    }
    return body;
}

export function decodeHappyPluginStorageValue(body: string): unknown {
    return JSON.parse(body) as unknown;
}

export function assertHappyPluginStorageQuota(bytes: number): void {
    if (bytes > HAPPY_PLUGIN_MAX_STORAGE_BYTES) {
        throw new Error("The plugin storage quota is full.");
    }
}
