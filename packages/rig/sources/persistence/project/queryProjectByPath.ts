import { eq } from "drizzle-orm";

import type { Project } from "../../protocol/index.js";
import { projects } from "../database/schema.js";
import type { TX } from "../Transaction.js";
import { projectReadRow } from "./impl/projectReadRow.js";

export function queryProjectByPath(tx: TX, path: string): Project | undefined {
    const row = tx.select().from(projects).where(eq(projects.path, path)).get();
    return row === undefined ? undefined : projectReadRow(row, null);
}
