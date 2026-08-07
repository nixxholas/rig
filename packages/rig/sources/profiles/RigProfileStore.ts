import { createId } from "@paralleldrive/cuid2";

import { createEventIdFactory, type RigProfileChangedEvent } from "../protocol/index.js";
import type {
    RigProfile,
    RigProfilePhoto,
    UpdateRigProfileRequest,
} from "../protocol/ProfileProtocol.js";
import type { TX } from "../persistence/Transaction.js";
import { queryRigProfile, queryRigProfiles } from "../persistence/profile/queryRigProfiles.js";
import { rigProfileCreate } from "../persistence/profile/rigProfileCreate.js";
import { rigProfileUpdate } from "../persistence/profile/rigProfileUpdate.js";
import { sameRigProfile } from "./sameRigProfile.js";

export interface RigProfileStoreOptions {
    database: RigProfileDatabase;
    localInstanceId: string;
    now?: () => number;
    publish: (event: RigProfileChangedEvent) => void;
}

export interface RigProfileDatabase {
    query<T>(operation: (tx: TX) => T): T;
    transaction<T>(operation: (tx: TX) => T): T;
}

export const MAXIMUM_RIG_PROFILES_PER_PARENT = 64;

export class RigProfileStore {
    readonly #database: RigProfileDatabase;
    readonly #localInstanceId: string;
    readonly #nextEventId: () => string;
    readonly #now: () => number;
    readonly #publish: (event: RigProfileChangedEvent) => void;

    constructor(options: RigProfileStoreOptions) {
        this.#database = options.database;
        this.#localInstanceId = options.localInstanceId;
        this.#now = options.now ?? Date.now;
        this.#nextEventId = createEventIdFactory({ now: this.#now });
        this.#publish = options.publish;
    }

    list(): readonly RigProfile[] {
        return this.#database.query(queryRigProfiles);
    }

    get(profileId: string): RigProfile | undefined {
        return this.#database.query((tx) => queryRigProfile(tx, profileId));
    }

    create(input: { name: string; photo?: RigProfilePhoto }): RigProfile {
        const now = this.#now();
        const profile: RigProfile = {
            createdAt: now,
            id: createId(),
            name: input.name,
            parentInstanceId: this.#localInstanceId,
            ...(input.photo === undefined ? {} : { photo: input.photo }),
            updatedAt: now,
            version: 1,
        };
        this.#database.transaction((tx) => {
            this.#assertParentCapacity(tx, this.#localInstanceId);
            rigProfileCreate(tx, profile);
        });
        this.#publishChanged(profile);
        return profile;
    }

    update(
        profileId: string,
        input: Omit<UpdateRigProfileRequest, "photo"> & {
            photo?: RigProfilePhoto | null;
        },
    ): RigProfile | undefined {
        const updated = this.#database.transaction((tx): RigProfile | undefined => {
            const current = queryRigProfile(tx, profileId);
            if (current === undefined) return undefined;
            if (current.parentInstanceId !== this.#localInstanceId) {
                throw new Error("Only a profile's parent Rig may change it.");
            }
            const now = this.#now();
            const { photo: currentPhoto, ...withoutPhoto } = current;
            const next: RigProfile = {
                ...withoutPhoto,
                ...(input.name === undefined ? {} : { name: input.name }),
                ...(input.photo === undefined
                    ? currentPhoto === undefined
                        ? {}
                        : { photo: currentPhoto }
                    : input.photo === null
                      ? {}
                      : { photo: input.photo }),
                updatedAt: now,
                version: current.version + 1,
            };
            rigProfileUpdate(tx, next);
            return next;
        });
        if (updated !== undefined) this.#publishChanged(updated);
        return updated;
    }

    replicate(profile: RigProfile, authenticatedParentId: string): RigProfile {
        if (
            profile.parentInstanceId !== authenticatedParentId ||
            profile.parentInstanceId === this.#localInstanceId
        ) {
            throw new Error("The Rig profile is not owned by its authenticated parent.");
        }
        let stored = profile;
        let changed = false;
        this.#database.transaction((tx) => {
            const current = queryRigProfile(tx, profile.id);
            if (current === undefined) {
                this.#assertParentCapacity(tx, profile.parentInstanceId);
                rigProfileCreate(tx, profile);
                changed = true;
                return;
            }
            if (
                current.parentInstanceId !== profile.parentInstanceId ||
                current.createdAt !== profile.createdAt
            ) {
                throw new Error("The Rig profile ID is already owned by another parent.");
            }
            if (current.version === profile.version) {
                if (!sameRigProfile(current, profile)) {
                    throw new Error("The Rig profile version was reused for different content.");
                }
                stored = current;
                return;
            }
            if (current.version > profile.version) {
                stored = current;
                return;
            }
            rigProfileUpdate(tx, profile);
            changed = true;
        });
        if (changed) this.#publishChanged(stored);
        return stored;
    }

    owns(profileId: string, parentInstanceId: string): boolean {
        return this.get(profileId)?.parentInstanceId === parentInstanceId;
    }

    isLocal(profileId: string): boolean {
        return this.owns(profileId, this.#localInstanceId);
    }

    #publishChanged(profile: RigProfile): void {
        this.#publish({
            createdAt: this.#now(),
            data: { profileId: profile.id, version: profile.version },
            id: this.#nextEventId(),
            type: "profile_changed",
        });
    }

    #assertParentCapacity(tx: TX, parentInstanceId: string): void {
        const count = queryRigProfiles(tx).filter(
            (profile) => profile.parentInstanceId === parentInstanceId,
        ).length;
        if (count >= MAXIMUM_RIG_PROFILES_PER_PARENT) {
            throw new Error("This Rig parent already has the maximum number of profiles.");
        }
    }
}
