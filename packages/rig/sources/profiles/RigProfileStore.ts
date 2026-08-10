import { createId } from "@paralleldrive/cuid2";
import type { Context } from "@steve.kite/stdlib";

import { createEventIdFactory, type RigProfileChangedEvent } from "../protocol/index.js";
import type {
    RigProfile,
    RigProfilePhoto,
    UpdateRigProfileRequest,
} from "../protocol/ProfileProtocol.js";
import { queryRigProfile, queryRigProfiles } from "../persistence/profile/queryRigProfiles.js";
import { rigProfileCreate } from "../persistence/profile/rigProfileCreate.js";
import { rigProfileUpdate } from "../persistence/profile/rigProfileUpdate.js";
import { sameRigProfile } from "./sameRigProfile.js";

export interface RigProfileStoreOptions {
    database: RigProfileDatabase;
    localInstanceId: string;
    now?: () => number;
    publish: (ctx: Context, event: RigProfileChangedEvent) => void | Promise<void>;
}

export interface RigProfileDatabase {
    query<T>(ctx: Context, operation: (ctx: Context) => Promise<T>): Promise<T>;
    transaction<T>(ctx: Context, operation: (ctx: Context) => Promise<T>): Promise<T>;
}

export const MAXIMUM_RIG_PROFILES_PER_PARENT = 64;

export class RigProfileStore {
    readonly #database: RigProfileDatabase;
    readonly #localInstanceId: string;
    readonly #nextEventId: () => string;
    readonly #now: () => number;
    readonly #publish: (ctx: Context, event: RigProfileChangedEvent) => void | Promise<void>;

    constructor(options: RigProfileStoreOptions) {
        this.#database = options.database;
        this.#localInstanceId = options.localInstanceId;
        this.#now = options.now ?? Date.now;
        this.#nextEventId = createEventIdFactory({ now: this.#now });
        this.#publish = options.publish;
    }

    async list(ctx: Context): Promise<readonly RigProfile[]> {
        return this.#database.query(ctx, async (ctx) => queryRigProfiles(ctx));
    }

    async get(ctx: Context, profileId: string): Promise<RigProfile | undefined> {
        return this.#database.query(ctx, async (ctx) => queryRigProfile(ctx, profileId));
    }

    async create(
        ctx: Context,
        input: {
            email: string;
            name: string;
            photo?: RigProfilePhoto;
        },
    ): Promise<RigProfile> {
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
        await this.#database.transaction(ctx, async (ctx) => {
            await this.#assertParentCapacity(ctx, this.#localInstanceId);
            await rigProfileCreate(ctx, profile);
        });
        await this.#publishChanged(ctx, profile);
        return profile;
    }

    async update(
        ctx: Context,
        profileId: string,
        input: Omit<UpdateRigProfileRequest, "photo"> & {
            photo?: RigProfilePhoto | null;
        },
    ): Promise<RigProfile | undefined> {
        const updated = await this.#database.transaction(
            ctx,
            async (ctx): Promise<RigProfile | undefined> => {
                const current = await queryRigProfile(ctx, profileId);
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
                await rigProfileUpdate(ctx, next);
                return next;
            },
        );
        if (updated !== undefined) await this.#publishChanged(ctx, updated);
        return updated;
    }

    async replicate(
        ctx: Context,
        profile: RigProfile,
        authenticatedParentId: string,
    ): Promise<RigProfile> {
        if (
            profile.parentInstanceId !== authenticatedParentId ||
            profile.parentInstanceId === this.#localInstanceId
        ) {
            throw new Error("The Rig profile is not owned by its authenticated parent.");
        }
        let stored = profile;
        let changed = false;
        await this.#database.transaction(ctx, async (ctx) => {
            const current = await queryRigProfile(ctx, profile.id);
            if (current === undefined) {
                await this.#assertParentCapacity(ctx, profile.parentInstanceId);
                await rigProfileCreate(ctx, profile);
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
            await rigProfileUpdate(ctx, profile);
            changed = true;
        });
        if (changed) await this.#publishChanged(ctx, stored);
        return stored;
    }

    async owns(ctx: Context, profileId: string, parentInstanceId: string): Promise<boolean> {
        return (await this.get(ctx, profileId))?.parentInstanceId === parentInstanceId;
    }

    async isLocal(ctx: Context, profileId: string): Promise<boolean> {
        return this.owns(ctx, profileId, this.#localInstanceId);
    }

    async #publishChanged(ctx: Context, profile: RigProfile): Promise<void> {
        await this.#publish(ctx, {
            createdAt: this.#now(),
            data: { profileId: profile.id, version: profile.version },
            id: this.#nextEventId(),
            type: "profile_changed",
        });
    }

    async #assertParentCapacity(ctx: Context, parentInstanceId: string): Promise<void> {
        const count = (await queryRigProfiles(ctx)).filter(
            (profile) => profile.parentInstanceId === parentInstanceId,
        ).length;
        if (count >= MAXIMUM_RIG_PROFILES_PER_PARENT) {
            throw new Error("This Rig parent already has the maximum number of profiles.");
        }
    }
}
