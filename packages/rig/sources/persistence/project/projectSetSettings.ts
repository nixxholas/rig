import { and, eq, sql } from "drizzle-orm";

import type { ProjectSettingsUpdate } from "../../protocol/index.js";
import { projects } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";
import { projectNotUserMutatedSince } from "./projectConditions.js";

export function projectSetSettings(
    tx: TX,
    id: string,
    settings: ProjectSettingsUpdate,
    now: number,
    version?: number,
): number {
    const compute = settings.defaultWorkspaceCompute;
    const dockerImage = compute?.type === "docker" ? compute.image.trim() : null;
    if (compute?.type === "docker" && (dockerImage === "" || /\s/u.test(compute.image))) {
        throw new Error("The default Docker image must not contain whitespace.");
    }
    return inTx(tx, (tx) => {
        const current = tx
            .select({
                compute: projects.defaultCompute,
                dockerImage: projects.defaultDockerImage,
                generation: projects.defaultComputeGeneration,
            })
            .from(projects)
            .where(eq(projects.id, id))
            .get();
        if (current === undefined) return 0;
        const computeChanged =
            current.compute !== (compute?.type ?? null) || current.dockerImage !== dockerImage;
        return Number(
            tx
                .update(projects)
                .set({
                    defaultCompute: compute?.type ?? null,
                    defaultComputeGeneration: computeChanged
                        ? current.generation + 1
                        : current.generation,
                    defaultDockerImage: dockerImage,
                    updatedAtMs: now,
                    userMutationVersion: sql`${projects.version} + 1`,
                    version: sql`${projects.version} + 1`,
                })
                .where(and(eq(projects.id, id), projectNotUserMutatedSince(version)))
                .run().changes,
        );
    });
}
