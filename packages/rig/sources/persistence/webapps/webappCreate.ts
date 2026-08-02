import { webapps, webappVersions } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";

export interface WebappCreateRecord {
    authorSessionId: string;
    changeDescription: string;
    createdAt: number;
    description: string;
    name: string;
    purpose: string;
    sourceDescription?: string;
}

/** Writes the webapp identity together with its first version so neither exists alone. */
export function webappCreate(tx: TX, record: WebappCreateRecord): void {
    inTx(tx, (transaction) => {
        transaction
            .insert(webapps)
            .values({
                authorSessionId: record.authorSessionId,
                createdAtMs: record.createdAt,
                currentVersion: 1,
                description: record.description,
                name: record.name,
                purpose: record.purpose,
                sourceDescription: record.sourceDescription ?? null,
                updatedAtMs: record.createdAt,
            })
            .run();
        transaction
            .insert(webappVersions)
            .values({
                changeDescription: record.changeDescription,
                createdAtMs: record.createdAt,
                version: 1,
                webappName: record.name,
            })
            .run();
    });
}
