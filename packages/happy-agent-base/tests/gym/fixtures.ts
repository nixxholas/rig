import type {
    BaseProvider,
    SessionEvent,
    SessionSystemMessage,
    SessionUserMessage,
} from "@slopus/happy-providers";
import type { Context } from "@steve.kite/stdlib";

import {
    AgentKV,
    AgentProviders,
    type AgentRecord,
    type AgentStorageLock,
} from "../../sources/index.js";
import { InMemoryPersistence } from "./InMemoryPersistence.js";

/** A registry holding the one provider under the ID `"scripted"` that tests configure. */
export function providersOf(provider: BaseProvider): AgentProviders {
    const providers = new AgentProviders();
    providers.add("scripted", provider, "gym");
    return providers;
}

/**
 * A store standing in for the one a collection shares between its agents, for a test that builds
 * an `Agent` directly instead of going through an `AgentSystemLocal`.
 */
export function sharedKV(): AgentKV {
    return new AgentKV(new InMemoryPersistence(), "shared.");
}

/**
 * A process-local stand-in for the hard database lock production AgentStorage adapters provide.
 * Reuse one returned function across storage objects to model one durable database.
 */
export function inMemoryStorageLock(): (ctx: Context) => Promise<AgentStorageLock> {
    let held = false;
    return () => {
        if (held) return Promise.reject(new Error("The agent store is already locked."));
        held = true;
        let released = false;
        return Promise.resolve({
            release: () => {
                if (!released) {
                    released = true;
                    held = false;
                }
                return Promise.resolve();
            },
        });
    };
}

/** A complete scripted turn that streams the text one character at a time and ends normally. */
export function textTurn(text: string): SessionEvent[] {
    return [
        { type: "text_start" },
        ...[...text].map((char) => ({ type: "text_delta", delta: char }) as const),
        { type: "text_end" },
        {
            type: "done",
            state: "normal",
            tokens: { input: 1, output: 1 },
        },
    ];
}

export function user(text: string): SessionUserMessage {
    return { role: "user", content: [{ type: "text", text }] };
}

/** One deterministic persisted user record for pre-seeded test history. */
export function userRecord(text: string): Extract<AgentRecord, { readonly type: "user" }> {
    const message = user(text);
    return { type: "user", id: messageId(message), message };
}

export function system(text: string): SessionSystemMessage {
    return { role: "system", content: [{ type: "text", text }] };
}

/** The durable envelope a queued message is stored under before it is consumed. */
export function queued(message: SessionUserMessage): {
    id: string;
    message: SessionUserMessage;
    options: Record<string, never>;
} {
    return { id: messageId(message), message, options: {} };
}

function messageId(message: SessionUserMessage): string {
    const serialized = JSON.stringify(message);
    let hash = 0;
    for (const character of serialized) {
        hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
    }
    return `q${hash.toString(36).padEnd(23, "0")}`;
}
