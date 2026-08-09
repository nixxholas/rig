import { and, eq, ne, sql } from "drizzle-orm";
import { projects } from "../database/schema.js";
import { projectNameKey } from "../../project/projectIdentity.js";
import { inTx } from "../inTx.js";
import type { DatabaseScope } from "../Transaction.js";

export async function projectAdoptRemoteName(
    tx: DatabaseScope,
    id: string,
    name: string,
    now: number,
): Promise<number> {
    return await inTx(tx, async (tx) => {
        const reservedName = await reserveUnique(
            name,
            async (candidate) =>
                (await tx
                    .select({ id: projects.id })
                    .from(projects)
                    .where(
                        and(eq(projects.nameKey, projectNameKey(candidate)), ne(projects.id, id)),
                    )
                    .get()) !== undefined,
        );
        return Number(
            (
                await tx
                    .update(projects)
                    .set({
                        name: reservedName,
                        nameKey: projectNameKey(reservedName),
                        nameSource: "git_remote",
                        updatedAtMs: now,
                        version: sql`${projects.version} + 1`,
                    })
                    .where(and(eq(projects.id, id), eq(projects.nameSource, "folder")))
                    .run()
            ).rowsAffected,
        );
    });
}

async function reserveUnique(
    base: string,
    taken: (candidate: string) => Promise<boolean>,
): Promise<string> {
    if (!(await taken(base))) return base;
    for (let suffix = 2; ; suffix += 1) {
        const candidate = `${base} (${String(suffix)})`;
        if (!(await taken(candidate))) return candidate;
    }
}
