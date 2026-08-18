import { createId } from "@paralleldrive/cuid2";
import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentDatabase,
    type AgentModule,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { sql } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

import {
    createProfileInputSchema,
    profileModuleListenerSchema,
    profileSchema,
    updateProfileInputSchema,
    type CreateProfileInput,
    type Profile,
    type UpdateProfileInput,
} from "./ProfileTypes.js";

export const PROFILE_MIGRATION_KEY = "001-profile";

const PROFILE_TABLE = "happy_agent_profile";

export const profileModuleOptionsSchema = Type.Object(
    {
        listener: Type.Optional(profileModuleListenerSchema),
        now: Type.Optional(Type.Function([], Type.Integer({ minimum: 0 }))),
    },
    { additionalProperties: false },
);
export type ProfileModuleOptions = Static<typeof profileModuleOptionsSchema>;

/**
 * The one person this installation belongs to.
 *
 * A profile is what sharing puts on the wire so a contact sees a name rather than a key, and
 * what a project records about who created it. One installation is one person, so there is
 * exactly one profile here — creating a second is refused rather than silently ignored.
 */
export class ProfileModule<Database extends AgentDatabase = AgentDatabase>
    implements AgentModule<never, Database>
{
    readonly name = "profile";
    readonly migrations: readonly AgentModuleMigration<Database>[] = [
        [
            PROFILE_MIGRATION_KEY,
            async (_ctx, database) => {
                await agentDatabaseRun(
                    database,
                    sql`CREATE TABLE IF NOT EXISTS ${sql.raw(PROFILE_TABLE)} (
                        singleton_id INTEGER PRIMARY KEY,
                        profile_json TEXT NOT NULL
                    )`,
                );
            },
        ],
    ] as readonly AgentModuleMigration<Database>[];
    readonly #now: () => number;
    readonly #listener: ProfileModuleOptions["listener"];
    /** This machine, learned from the agent the profile is opened for. */
    #localInstanceId: string | undefined;

    constructor(options: ProfileModuleOptions = {}) {
        if (!Value.Check(profileModuleOptionsSchema, options)) {
            throw new Error("Profile module options are invalid.");
        }
        this.#now = options.now ?? Date.now;
        this.#listener = options.listener;
    }

    /**
     * Says which installation this is.
     *
     * A profile records the machine it was made on so another machine that later reads it knows
     * it may not speak for that person. The agent this installation runs as is that machine, and
     * it is only known once the agent exists, so it arrives here rather than at construction.
     */
    open(agentId: string): void {
        this.#localInstanceId = agentId;
    }

    /** The profile, or nothing when nobody has been named yet. */
    async get(ctx: Context): Promise<Profile | undefined> {
        const rows = await agentDatabaseRows<{ profile_json: string }>(
            ctx.db,
            sql`SELECT profile_json FROM ${sql.raw(PROFILE_TABLE)} WHERE singleton_id = 1`,
        );
        const row = rows[0];
        if (row === undefined) return undefined;
        let value: unknown;
        try {
            value = JSON.parse(row.profile_json);
        } catch (error: unknown) {
            throw new Error("The stored profile is not readable.", { cause: error });
        }
        if (!Value.Check(profileSchema, value)) {
            throw new Error("The stored profile is invalid.");
        }
        return structuredClone(value) as Profile;
    }

    /** The same profile, addressed by id, so a caller holding one can confirm it still exists. */
    async getById(ctx: Context, profileId: string): Promise<Profile | undefined> {
        const profile = await this.get(ctx);
        return profile?.id === profileId ? profile : undefined;
    }

    /** Whether this installation owns that profile, and may therefore act as that person. */
    async isLocal(ctx: Context, profileId: string): Promise<boolean> {
        const profile = await this.getById(ctx, profileId);
        if (profile === undefined || this.#localInstanceId === undefined) return false;
        return profile.parentInstanceId === this.#localInstanceId;
    }

    async create(ctx: Context, input: CreateProfileInput): Promise<Profile> {
        if (!Value.Check(createProfileInputSchema, input)) {
            throw new Error("The profile name or email address is not valid.");
        }
        const instanceId = this.#requireInstance();
        const now = this.#now();
        const profile = await ctx.inTx(async (txCtx): Promise<Profile> => {
            if ((await this.get(txCtx)) !== undefined) {
                throw new Error("This installation already has a profile.");
            }
            const created: Profile = {
                createdAt: now,
                email: input.email,
                id: createId(),
                name: input.name,
                parentInstanceId: instanceId,
                updatedAt: now,
                version: 1,
            };
            await this.#write(txCtx, created);
            return created;
        });
        await this.#publishChanged(ctx, profile);
        return profile;
    }

    async update(
        ctx: Context,
        profileId: string,
        input: UpdateProfileInput,
    ): Promise<Profile | undefined> {
        if (!Value.Check(updateProfileInputSchema, input)) {
            throw new Error("The profile name or email address is not valid.");
        }
        const instanceId = this.#requireInstance();
        const updated = await ctx.inTx(async (txCtx): Promise<Profile | undefined> => {
            const current = await this.getById(txCtx, profileId);
            if (current === undefined) return undefined;
            if (current.parentInstanceId !== instanceId) {
                throw new Error("Only this profile's own installation may change it.");
            }
            const next: Profile = {
                ...current,
                ...(input.email === undefined ? {} : { email: input.email }),
                ...(input.name === undefined ? {} : { name: input.name }),
                updatedAt: this.#now(),
                version: current.version + 1,
            };
            await this.#write(txCtx, next);
            return next;
        });
        if (updated !== undefined) await this.#publishChanged(ctx, updated);
        return updated;
    }

    #requireInstance(): string {
        const instanceId = this.#localInstanceId;
        if (instanceId === undefined) throw new Error("The profile is not open yet.");
        return instanceId;
    }

    async #write(ctx: Context, profile: Profile): Promise<void> {
        if (!Value.Check(profileSchema, profile)) {
            throw new Error("The profile is not valid.");
        }
        await agentDatabaseRun(
            ctx.db,
            sql`INSERT INTO ${sql.raw(PROFILE_TABLE)} (singleton_id, profile_json)
                VALUES (1, ${JSON.stringify(profile)})
                ON CONFLICT (singleton_id)
                DO UPDATE SET profile_json = EXCLUDED.profile_json`,
        );
    }

    async #publishChanged(ctx: Context, profile: Profile): Promise<void> {
        await this.#listener?.onEvent?.(ctx, {
            createdAt: this.#now(),
            data: { profileId: profile.id, version: profile.version },
            id: `${profile.id}-${profile.version}`,
            type: "profile_changed",
        });
    }
}
