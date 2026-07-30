import { sql } from "drizzle-orm";

import type { SecretRegistration } from "../../secrets/index.js";
import type { TX } from "../Transaction.js";
import { readString } from "./impl/sqliteRow.js";

export function querySecretRegistrations(tx: TX): {
    environmentVariables: readonly { name: string; secretId: string }[];
    registrations: readonly SecretRegistration[];
} {
    const registrations = tx
        .all<Record<string, unknown>>(
            sql`SELECT id, description, environment_json FROM secret_registrations`,
        )
        .map((row) => ({
            description: readString(row, "description"),
            environment: JSON.parse(readString(row, "environment_json")) as Readonly<
                Record<string, string>
            >,
            id: readString(row, "id"),
        }));
    const environmentVariables = tx
        .all<Record<string, unknown>>(sql`SELECT secret_id, name FROM secret_environment_variables`)
        .map((row) => ({
            name: readString(row, "name"),
            secretId: readString(row, "secret_id"),
        }));
    return { environmentVariables, registrations };
}
