import { randomBytes } from "node:crypto";

import { Value } from "@sinclair/typebox/value";

import { webappContextSchema, type WebappContext } from "../protocol/WebappProtocol.js";

export const WEBAPP_CONTEXT_TOKEN_TTL_MS = 5 * 60 * 1_000;
export const WEBAPP_CONTEXT_TOKEN_CAP = 1_024;

type WebappContextTokenStoreOptions = {
    cap?: number;
    now?: () => number;
    randomToken?: () => string;
    ttlMs?: number;
};

type OutstandingWebappContext = {
    context: WebappContext;
    expiresAt: number;
};

/**
 * Keeps the short-lived bearer capabilities used by hosted webapps to read their launch context.
 * A successful exchange consumes the token.
 */
export class WebappContextTokenStore {
    readonly #cap: number;
    readonly #now: () => number;
    readonly #outstanding = new Map<string, OutstandingWebappContext>();
    readonly #randomToken: () => string;
    readonly #ttlMs: number;

    constructor(options: WebappContextTokenStoreOptions = {}) {
        this.#cap = options.cap ?? WEBAPP_CONTEXT_TOKEN_CAP;
        this.#now = options.now ?? Date.now;
        this.#randomToken = options.randomToken ?? (() => randomBytes(32).toString("base64url"));
        this.#ttlMs = options.ttlMs ?? WEBAPP_CONTEXT_TOKEN_TTL_MS;
    }

    mint(context: WebappContext): string {
        if (!Value.Check(webappContextSchema, context)) {
            throw new Error("The webapp context is invalid.");
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

    exchange(webapp: string, token: string): WebappContext | undefined {
        const outstanding = this.#outstanding.get(token);
        if (outstanding === undefined) return undefined;
        if (this.#now() >= outstanding.expiresAt) {
            this.#outstanding.delete(token);
            return undefined;
        }
        if (outstanding.context.webapp !== webapp) return undefined;
        this.#outstanding.delete(token);
        return outstanding.context;
    }

    #removeExpired(now: number): void {
        for (const [token, outstanding] of this.#outstanding) {
            if (now >= outstanding.expiresAt) this.#outstanding.delete(token);
        }
    }
}
