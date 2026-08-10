import type { Context } from "@steve.kite/stdlib";

import { sql } from "drizzle-orm";

import type { RegisterSecretRequest } from "../../protocol/index.js";
import { secretEnvironmentVariables, secretRegistrations } from "../database/schema.js";
import { inTx } from "../inTx.js";

export async function secretRegister(ctx: Context, request: RegisterSecretRequest): Promise<void> {
    await inTx(ctx, "rig.sql.session.secret_register", async (ctx) => {
        const tx = ctx.tx;
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
