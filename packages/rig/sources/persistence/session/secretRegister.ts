import { sql } from "drizzle-orm";

import type { RegisterSecretRequest } from "../../protocol/index.js";
import { secretEnvironmentVariables, secretRegistrations } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { DatabaseScope } from "../Transaction.js";

export async function secretRegister(
    tx: DatabaseScope,
    request: RegisterSecretRequest,
): Promise<void> {
    await inTx(tx, async (tx) => {
        await tx
            .insert(secretRegistrations)
            .values({
                description: request.description.trim(),
                environmentJson: JSON.stringify(request.environment),
                id: request.id,
            })
            .onConflictDoUpdate({
                set: {
                    description: sql`excluded.description`,
                    environmentJson: sql`excluded.environment_json`,
                },
                target: secretRegistrations.id,
            })
            .run();
        for (const name of Object.keys(request.environment)) {
            await tx
                .insert(secretEnvironmentVariables)
                .values({
                    name,
                    normalizedName: name.toUpperCase(),
                    secretId: request.id,
                })
                .onConflictDoUpdate({
                    set: { name: sql`excluded.name` },
                    target: [
                        secretEnvironmentVariables.secretId,
                        secretEnvironmentVariables.normalizedName,
                    ],
                })
                .run();
        }
    });
}
