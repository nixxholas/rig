import type { MurmurStore, StoreTransaction } from "@slopus/murmur";

import { isDatabaseFailure } from "../../persistence/isDatabaseFailure.js";

/**
 * Preserves the original SQLite failure when Murmur collapses settled transport
 * reads into a generic synchronization error.
 */
export class DatabaseFailureObservingMurmurStore implements MurmurStore {
    readonly #store: MurmurStore;
    #databaseFailure: unknown;

    constructor(store: MurmurStore) {
        this.#store = store;
    }

    takeDatabaseFailure(): unknown {
        const failure = this.#databaseFailure;
        this.#databaseFailure = undefined;
        return failure;
    }

    get(key: string): Promise<Uint8Array | undefined> {
        return this.#observe(() => this.#store.get(key));
    }

    set(key: string, value: Uint8Array): Promise<void> {
        return this.#observe(() => this.#store.set(key, value));
    }

    delete(key: string): Promise<void> {
        return this.#observe(() => this.#store.delete(key));
    }

    list(prefix: string): Promise<ReadonlyMap<string, Uint8Array>> {
        return this.#observe(() => this.#store.list(prefix));
    }

    transaction<Result>(
        operation: (transaction: StoreTransaction) => Promise<Result>,
    ): Promise<Result> {
        return this.#observe(() =>
            this.#store.transaction((transaction) =>
                operation({
                    delete: (key) => this.#observe(() => transaction.delete(key)),
                    get: (key) => this.#observe(() => transaction.get(key)),
                    list: (prefix) => this.#observe(() => transaction.list(prefix)),
                    set: (key, value) => this.#observe(() => transaction.set(key, value)),
                }),
            ),
        );
    }

    async #observe<Result>(operation: () => Promise<Result>): Promise<Result> {
        try {
            return await operation();
        } catch (error: unknown) {
            if (this.#databaseFailure === undefined && isDatabaseFailure(error)) {
                this.#databaseFailure = error;
            }
            throw error;
        }
    }
}
