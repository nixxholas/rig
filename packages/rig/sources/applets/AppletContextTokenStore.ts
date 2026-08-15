import { randomBytes } from "node:crypto";

import { Value } from "@sinclair/typebox/value";

import { appletContextSchema, type AppletContext } from "../protocol/AppletProtocol.js";

export const APPLET_CONTEXT_TOKEN_TTL_MS = 5 * 60 * 1_000;
export const APPLET_CONTEXT_TOKEN_CAP = 1_024;

type AppletContextTokenStoreOptions = {
    cap?: number;
    now?: () => number;
    randomToken?: () => string;
    ttlMs?: number;
};

type OutstandingAppletContext = {
    context: AppletContext;
    expiresAt: number;
};

/**
 * Keeps the short-lived bearer capabilities used by hosted applets to read their launch context.
 * A successful exchange consumes the token.
 */
export class AppletContextTokenStore {
    readonly #cap: number;
    readonly #now: () => number;
    readonly #outstanding = new Map<string, OutstandingAppletContext>();
    readonly #randomToken: () => string;
    readonly #ttlMs: number;

    constructor(options: AppletContextTokenStoreOptions = {}) {
        this.#cap = options.cap ?? APPLET_CONTEXT_TOKEN_CAP;
        this.#now = options.now ?? Date.now;
        this.#randomToken = options.randomToken ?? (() => randomBytes(32).toString("base64url"));
        this.#ttlMs = options.ttlMs ?? APPLET_CONTEXT_TOKEN_TTL_MS;
    }

    mint(context: AppletContext): string {
        if (!Value.Check(appletContextSchema, context)) {
            throw new Error("The applet context is invalid.");
        }
        const now = this.#now();
        this.#removeExpired(now);
        while (this.#outstanding.size >= this.#cap) {
            const oldest = this.#outstanding.keys().next().value;
            if (oldest === undefined) break;
            this.#outstanding.delete(oldest);
        }
        let token = this.#randomToken();
        while (this.#outstanding.has(token)) token = this.#randomToken();
        this.#outstanding.set(token, { context, expiresAt: now + this.#ttlMs });
        return token;
    }

    exchange(applet: string, token: string): AppletContext | undefined {
        const outstanding = this.#outstanding.get(token);
        if (outstanding === undefined) return undefined;
        if (this.#now() >= outstanding.expiresAt) {
            this.#outstanding.delete(token);
            return undefined;
        }
        if (outstanding.context.applet !== applet) return undefined;
        this.#outstanding.delete(token);
        return outstanding.context;
    }

    #removeExpired(now: number): void {
        for (const [token, outstanding] of this.#outstanding) {
            if (now >= outstanding.expiresAt) this.#outstanding.delete(token);
        }
    }
}
