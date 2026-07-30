import { and, eq, ne, sql } from "drizzle-orm";
import { projects } from "../database/schema.js";
import { projectNameKey } from "../../project/projectIdentity.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";

export function projectAdoptRemoteName(tx: TX, id: string, name: string, now: number): number {
    return inTx(tx, (tx) => {
        const reservedName = reserveUnique(
            name,
            (candidate) =>
                tx
                    .select({ id: projects.id })
                    .from(projects)
                    .where(
                        and(eq(projects.nameKey, projectNameKey(candidate)), ne(projects.id, id)),
                    )
                    .get() !== undefined,
        );
        return Number(
            tx
                .update(projects)
                .set({
                    name: reservedName,
                    nameKey: projectNameKey(reservedName),
                    nameSource: "git_remote",
                    updatedAtMs: now,
                    version: sql`${projects.version} + 1`,
                })
                .where(and(eq(projects.id, id), eq(projects.nameSource, "folder")))
                .run().changes,
        );
    });
}

function reserveUnique(base: string, taken: (candidate: string) => boolean): string {
    if (!taken(base)) return base;
    for (let suffix = 2; ; suffix += 1) {
        const candidate = `${base} (${String(suffix)})`;
        if (!taken(candidate)) return candidate;
    }
}
