import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { eq } from "drizzle-orm";

import type { Project } from "../../protocol/index.js";
import { projects } from "../database/schema.js";
import { projectReadRow } from "./impl/projectReadRow.js";

export async function queryProjectByPath(ctx: Context, path: string): Promise<Project | undefined> {
    return await inDatabase(ctx, "rig.sql.project.queryProjectByPath", async (ctx) => {
        const tx = ctx.tx;
        const row = await tx.select().from(projects).where(eq(projects.path, path)).get();
        return row === undefined ? undefined : projectReadRow(row, null);
    });
}
