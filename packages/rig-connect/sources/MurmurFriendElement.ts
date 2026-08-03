import type { ConnectionState } from "./ChatElement.js";
import type {
    GetMurmurFriendsResponse,
    MurmurAccount,
    MurmurContact,
    MurmurFriendship,
    MurmurFriendStats,
    MurmurServiceState,
} from "./protocol.js";

/**
 * The complete, render-ready projection of a person's Murmur social graph.
 *
 * Every read returns a reference-stable value: a refetch which says nothing
 * new keeps the existing arrays and entities so a UI can avoid unnecessary
 * redraws without rebuilding the graph itself.
 */
export interface MurmurFriendsState {
    account?: MurmurAccount;
    connection: ConnectionState;
    contacts: readonly MurmurContact[];
    friendships: readonly MurmurFriendship[];
    service: MurmurServiceState;
    stats: MurmurFriendStats;
}

const initialService: MurmurServiceState = { relayUrls: [], status: "stopped" };
const initialStats: MurmurFriendStats = {
    acceptedRequests: 0,
    autoAcceptedRequests: 0,
    contacts: 0,
    incomingPending: 0,
    outgoingPending: 0,
    rejectedRequests: 0,
};

/** Immutable, reference-stable projection of the authoritative friends snapshot. */
export class MurmurFriendsStore {
    #state: MurmurFriendsState = {
        connection: "connecting",
        contacts: [],
        friendships: [],
        service: initialService,
        stats: initialStats,
    };

    state(): MurmurFriendsState {
        return this.#state;
    }

    replace(snapshot: GetMurmurFriendsResponse, connection: ConnectionState): boolean {
        const friendships = reuseByIdentity(
            this.#state.friendships,
            snapshot.friendships,
            (friendship) => friendship.peerId,
        );
        const contacts = reuseByIdentity(
            this.#state.contacts,
            snapshot.contacts,
            (contact) => contact.id,
        );
        const account = sameValue(this.#state.account, snapshot.account)
            ? this.#state.account
            : snapshot.account;
        const service = sameValue(this.#state.service, snapshot.service)
            ? this.#state.service
            : snapshot.service;
        const stats = sameValue(this.#state.stats, snapshot.stats)
            ? this.#state.stats
            : snapshot.stats;
        const unchanged =
            account === this.#state.account &&
            service === this.#state.service &&
            stats === this.#state.stats &&
            friendships === this.#state.friendships &&
            contacts === this.#state.contacts &&
            connection === this.#state.connection;
        if (unchanged) return false;
        this.#state = {
            ...(account === undefined ? {} : { account }),
            connection,
            contacts,
            friendships,
            service,
            stats,
        };
        return true;
    }

    setConnection(connection: ConnectionState): boolean {
        if (this.#state.connection === connection) return false;
        this.#state = { ...this.#state, connection };
        return true;
    }
}

function reuseByIdentity<T>(
    previous: readonly T[],
    next: readonly T[],
    key: (value: T) => string,
): readonly T[] {
    const previousByKey = new Map(previous.map((value) => [key(value), value]));
    const projected = next.map((value) => {
        const before = previousByKey.get(key(value));
        return before !== undefined && sameValue(before, value) ? before : value;
    });
    return sameReferences(previous, projected) ? previous : projected;
}

function sameReferences<T>(left: readonly T[], right: readonly T[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameValue(left: unknown, right: unknown): boolean {
    if (left === right) return true;
    if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
        return false;
    }
    if (Array.isArray(left) || Array.isArray(right)) {
        return (
            Array.isArray(left) &&
            Array.isArray(right) &&
            left.length === right.length &&
            left.every((value, index) => sameValue(value, right[index]))
        );
    }
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord);
    const rightKeys = Object.keys(rightRecord);
    return (
        leftKeys.length === rightKeys.length &&
        leftKeys.every(
            (key) =>
                Object.hasOwn(rightRecord, key) && sameValue(leftRecord[key], rightRecord[key]),
        )
    );
}
