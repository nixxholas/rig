import { inDatabase } from "../database/inDatabase.js";
import { eq } from "drizzle-orm";

import type { Project } from "../../protocol/index.js";
import { projects } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";
import { projectReadRow } from "./impl/projectReadRow.js";

export async function queryProjectByPath(
    tx: DatabaseScope,
    path: string,
): Promise<Project | undefined> {
    return await inDatabase(tx, async (tx) => {
        const row = await tx.select().from(projects).where(eq(projects.path, path)).get();
        return row === undefined ? undefined : projectReadRow(row, null);
    });
}
