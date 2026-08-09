import { and, count, eq, sql } from "drizzle-orm";

import type { ProjectAvatarSource } from "../../protocol/index.js";
import { projectAvatarAssets, projects } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { DatabaseScope, TX } from "../Transaction.js";
import { projectNotUserMutatedSince } from "./projectConditions.js";

export interface ProjectSetAvatarInput {
    asset: {
        byteLength: number;
        hash: string;
        height: number;
        width: number;
    };
    expectedVersion?: number;
    now: number;
    projectId: string;
    source: ProjectAvatarSource;
}

export async function projectSetAvatar(
    tx: DatabaseScope,
    input: ProjectSetAvatarInput,
): Promise<"missing" | "preserved" | "updated"> {
    return await inTx(tx, async (tx) => {
        const latest = await tx
            .select({
                avatarHash: projects.avatarHash,
                avatarSource: projects.avatarSource,
            })
            .from(projects)
            .where(eq(projects.id, input.projectId))
            .get();
        if (latest === undefined) return "missing";
        if (input.source !== "user" && latest.avatarSource === "user") return "preserved";

        await tx
            .insert(projectAvatarAssets)
            .values({
                byteLength: input.asset.byteLength,
                createdAtMs: input.now,
                dereferencedAtMs: null,
                hash: input.asset.hash,
                height: input.asset.height,
                mediaType: "image/webp",
                width: input.asset.width,
            })
            .onConflictDoUpdate({
                set: { dereferencedAtMs: null },
                target: projectAvatarAssets.hash,
            })
            .run();
        const changed = (
            await tx
                .update(projects)
                .set({
                    avatarHash: input.asset.hash,
                    avatarSource: input.source,
                    updatedAtMs: input.now,
                    ...(input.source === "user"
                        ? { userMutationVersion: sql`${projects.version} + 1` }
                        : {}),
                    version: sql`${projects.version} + 1`,
                })
                .where(
                    and(
                        eq(projects.id, input.projectId),
                        projectNotUserMutatedSince(input.expectedVersion),
                    ),
                )
                .run()
        ).rowsAffected;
        if (changed === 0) {
            throw new Error("The project changed before the avatar could be saved.");
        }
        if (latest.avatarHash !== null && latest.avatarHash !== input.asset.hash) {
            await dereferenceIfUnused(tx, latest.avatarHash, input.now);
        }
        return "updated";
    });
}

async function dereferenceIfUnused(tx: TX, hash: string, now: number): Promise<void> {
    const references = await tx
        .select({ value: count() })
        .from(projects)
        .where(eq(projects.avatarHash, hash))
        .get();
    if (references?.value !== 0) return;
    await tx
        .update(projectAvatarAssets)
        .set({ dereferencedAtMs: now })
        .where(eq(projectAvatarAssets.hash, hash))
        .run();
}
