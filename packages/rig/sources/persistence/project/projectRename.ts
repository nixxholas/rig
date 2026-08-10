import type { Context } from "@steve.kite/stdlib";

import { and, eq, ne, sql } from "drizzle-orm";
import { projects } from "../database/schema.js";
import { projectNameKey } from "../../project/projectIdentity.js";
import { inTx } from "../inTx.js";
import { projectNotUserMutatedSince } from "./projectConditions.js";

export async function projectRename(
    ctx: Context,
    id: string,
    name: string,
    now: number,
    version?: number,
): Promise<number> {
    return await inTx(ctx, "rig.sql.project.projectRename", async (ctx) => {
        const tx = ctx.tx;
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
                        nameSource: "user",
                        updatedAtMs: now,
                        userMutationVersion: sql`${projects.version} + 1`,
                        version: sql`${projects.version} + 1`,
                    })
                    .where(and(eq(projects.id, id), projectNotUserMutatedSince(version)))
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
