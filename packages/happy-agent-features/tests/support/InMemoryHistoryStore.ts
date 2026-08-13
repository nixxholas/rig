import type { HistoryMessage, HistoryRecord, HistoryStore } from "../../sources/index.js";

/** A store standing in for the archive a host would keep an agent's history in. */
export class InMemoryHistoryStore implements HistoryStore {
    /** Every message recorded, per agent, oldest first. */
    readonly messages = new Map<string, HistoryMessage[]>();
    /** Set to fail every append and read, standing in for an archive that is having a bad day. */
    broken = false;

    append(_ctx: unknown, agentId: string, messages: readonly HistoryMessage[]): Promise<void> {
        if (this.broken) return Promise.reject(new Error("The history store is unavailable."));
        const existing = this.messages.get(agentId);
        if (existing === undefined) this.messages.set(agentId, [...messages]);
        else existing.push(...messages);
        return Promise.resolve();
    }

    read(_ctx: unknown, agentId: string): Promise<readonly HistoryRecord[]> {
        if (this.broken) return Promise.reject(new Error("The history store is unavailable."));
        return Promise.resolve(
            (this.messages.get(agentId) ?? []).map((message, position) => ({
                message,
                position,
            })),
        );
    }
}
