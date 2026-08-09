import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";

import {
    environmentSecretRegistrationSchema,
    type EnvironmentSecretRegistration,
} from "../../secrets/index.js";
import type { DatabaseScope } from "../Transaction.js";
import { readString } from "./impl/sqliteRow.js";

export async function querySecretRegistrations(tx: DatabaseScope): Promise<{
    environmentVariables: readonly { name: string; secretId: string }[];
    registrations: readonly EnvironmentSecretRegistration[];
}> {
    return await inDatabase(tx, async (tx) => {
        const registrations = (
            await tx.all<Record<string, unknown>>(
                sql`SELECT id, description, environment_json FROM secret_registrations`,
            )
        ).map((row) => {
            const registration: unknown = {
                description: readString(row, "description"),
                environment: JSON.parse(readString(row, "environment_json")) as unknown,
                id: readString(row, "id"),
            };
            if (!Value.Check(environmentSecretRegistrationSchema, registration)) {
                throw new Error("A stored secret registration is invalid.");
            }
            return registration;
        });
        const environmentVariables = (
            await tx.all<Record<string, unknown>>(
                sql`SELECT secret_id, name FROM secret_environment_variables`,
            )
        ).map((row) => ({
            name: readString(row, "name"),
            secretId: readString(row, "secret_id"),
        }));
        return { environmentVariables, registrations };
    });
}
