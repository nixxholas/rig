import { Value } from "@sinclair/typebox/value";

import {
    type EnvironmentSecretRegistration,
    type SecretRegistration,
    environmentSecretRegistrationSchema,
    githubSecretRegistrationSchema,
} from "./types.js";

export function validateSecretRegistration(secret: SecretRegistration): void {
    if ("kind" in secret) {
        if (!Value.Check(githubSecretRegistrationSchema, secret)) {
            throw new Error("The secret does not match the GitHub secret schema.");
        }
        return;
    }
    if (!Value.Check(environmentSecretRegistrationSchema, secret)) {
        const paths = [...Value.Errors(environmentSecretRegistrationSchema, secret)].map(
            (error) => error.path,
        );
        if (paths.includes("/id")) {
            throw new Error(
                "Secret IDs must be 1-128 characters using letters, numbers, periods, underscores, colons, or hyphens.",
            );
        }
        if (paths.includes("/environment")) {
            throw new Error("A secret must contain at least one environment variable.");
        }
        if (paths.some((path) => path.startsWith("/environment/"))) {
            throw new Error("A secret contains an invalid environment variable name or value.");
        }
        throw new Error("The secret does not match a supported secret schema.");
    }
    validateEnvironmentSecretRegistration(secret);
}

export function validateEnvironmentSecretRegistration(secret: EnvironmentSecretRegistration): void {
    if (secret.id === "github") {
        throw new Error("Secret ID 'github' is reserved for GitHub CLI credentials.");
    }
    if (secret.description.trim().length === 0) {
        throw new Error(`Secret '${secret.id}' must have a description.`);
    }
    const names = new Set<string>();
    for (const name of Object.keys(secret.environment)) {
        const normalizedName = name.toUpperCase();
        if (names.has(normalizedName)) {
            throw new Error(`Secret '${secret.id}' contains duplicate environment variable names.`);
        }
        names.add(normalizedName);
    }
}
