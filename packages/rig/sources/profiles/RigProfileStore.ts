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
    publish: (event: RigProfileChangedEvent) => void | Promise<void>;
}

export interface RigProfileDatabase {
    query<T>(operation: (tx: TX) => Promise<T>): Promise<T>;
    transaction<T>(operation: (tx: TX) => Promise<T>): Promise<T>;
}

export const MAXIMUM_RIG_PROFILES_PER_PARENT = 64;

export class RigProfileStore {
    readonly #database: RigProfileDatabase;
    readonly #localInstanceId: string;
    readonly #nextEventId: () => string;
    readonly #now: () => number;
    readonly #publish: (event: RigProfileChangedEvent) => void | Promise<void>;

    constructor(options: RigProfileStoreOptions) {
        this.#database = options.database;
        this.#localInstanceId = options.localInstanceId;
        this.#now = options.now ?? Date.now;
        this.#nextEventId = createEventIdFactory({ now: this.#now });
        this.#publish = options.publish;
    }

    async list(): Promise<readonly RigProfile[]> {
        return this.#database.query(async (tx) => queryRigProfiles(tx));
    }

    async get(profileId: string): Promise<RigProfile | undefined> {
        return this.#database.query(async (tx) => queryRigProfile(tx, profileId));
    }

    async create(input: {
        email: string;
        name: string;
        photo?: RigProfilePhoto;
    }): Promise<RigProfile> {
        const now = this.#now();
        const profile: RigProfile = {
            createdAt: now,
            email: input.email,
            id: createId(),
            name: input.name,
            parentInstanceId: this.#localInstanceId,
            ...(input.photo === undefined ? {} : { photo: input.photo }),
            updatedAt: now,
            version: 1,
        };
        await this.#database.transaction(async (tx) => {
            await this.#assertParentCapacity(tx, this.#localInstanceId);
            await rigProfileCreate(tx, profile);
        });
        await this.#publishChanged(profile);
        return profile;
    }

    async update(
        profileId: string,
        input: Omit<UpdateRigProfileRequest, "photo"> & {
            photo?: RigProfilePhoto | null;
        },
    ): Promise<RigProfile | undefined> {
        const updated = await this.#database.transaction(
            async (tx): Promise<RigProfile | undefined> => {
                const current = await queryRigProfile(tx, profileId);
                if (current === undefined) return undefined;
                if (current.parentInstanceId !== this.#localInstanceId) {
                    throw new Error("Only a profile's parent Rig may change it.");
                }
                const now = this.#now();
                const { photo: currentPhoto, ...withoutPhoto } = current;
                const next: RigProfile = {
                    ...withoutPhoto,
                    ...(input.email === undefined ? {} : { email: input.email }),
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
                await rigProfileUpdate(tx, next);
                return next;
            },
        );
        if (updated !== undefined) await this.#publishChanged(updated);
        return updated;
    }

    async replicate(profile: RigProfile, authenticatedParentId: string): Promise<RigProfile> {
        if (
            profile.parentInstanceId !== authenticatedParentId ||
            profile.parentInstanceId === this.#localInstanceId
        ) {
            throw new Error("The Rig profile is not owned by its authenticated parent.");
        }
        let stored = profile;
        let changed = false;
        await this.#database.transaction(async (tx) => {
            const current = await queryRigProfile(tx, profile.id);
            if (current === undefined) {
                await this.#assertParentCapacity(tx, profile.parentInstanceId);
                await rigProfileCreate(tx, profile);
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
            await rigProfileUpdate(tx, profile);
            changed = true;
        });
        if (changed) await this.#publishChanged(stored);
        return stored;
    }

    async owns(profileId: string, parentInstanceId: string): Promise<boolean> {
        return (await this.get(profileId))?.parentInstanceId === parentInstanceId;
    }

    async isLocal(profileId: string): Promise<boolean> {
        return this.owns(profileId, this.#localInstanceId);
    }

    async #publishChanged(profile: RigProfile): Promise<void> {
        await this.#publish({
            createdAt: this.#now(),
            data: { profileId: profile.id, version: profile.version },
            id: this.#nextEventId(),
            type: "profile_changed",
        });
    }

    async #assertParentCapacity(tx: TX, parentInstanceId: string): Promise<void> {
        const count = (await queryRigProfiles(tx)).filter(
            (profile) => profile.parentInstanceId === parentInstanceId,
        ).length;
        if (count >= MAXIMUM_RIG_PROFILES_PER_PARENT) {
            throw new Error("This Rig parent already has the maximum number of profiles.");
        }
    }
}
