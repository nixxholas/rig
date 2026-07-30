import { and, count, eq, sql } from "drizzle-orm";

import type { ProjectAvatarSource } from "../../protocol/index.js";
import { projectAvatarAssets, projects } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";

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

export function projectSetAvatar(
    tx: TX,
    input: ProjectSetAvatarInput,
): "missing" | "preserved" | "updated" {
    return inTx(tx, (tx) => {
        const latest = tx
            .select({
                avatarHash: projects.avatarHash,
                avatarSource: projects.avatarSource,
                version: projects.version,
            })
            .from(projects)
            .where(eq(projects.id, input.projectId))
            .get();
        if (latest === undefined) return "missing";
        if (input.expectedVersion !== undefined && latest.version !== input.expectedVersion) {
            throw new Error("The project changed before the avatar could be saved.");
        }
        if (input.source !== "user" && latest.avatarSource === "user") return "preserved";

        tx.insert(projectAvatarAssets)
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
        tx.update(projects)
            .set({
                avatarHash: input.asset.hash,
                avatarSource: input.source,
                updatedAtMs: input.now,
                version: sql`${projects.version} + 1`,
            })
            .where(and(eq(projects.id, input.projectId), eq(projects.version, latest.version)))
            .run();
        if (latest.avatarHash !== null && latest.avatarHash !== input.asset.hash) {
            dereferenceIfUnused(tx, latest.avatarHash, input.now);
        }
        return "updated";
    });
}

function dereferenceIfUnused(tx: TX, hash: string, now: number): void {
    const references = tx
        .select({ value: count() })
        .from(projects)
        .where(eq(projects.avatarHash, hash))
        .get();
    if (references?.value !== 0) return;
    tx.update(projectAvatarAssets)
        .set({ dereferencedAtMs: now })
        .where(eq(projectAvatarAssets.hash, hash))
        .run();
}
