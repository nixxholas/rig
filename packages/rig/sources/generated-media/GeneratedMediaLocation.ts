import { posix, resolve } from "node:path";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const GeneratedMediaLocationSchema = Type.String({
    pattern: "^generated/[A-Za-z0-9][A-Za-z0-9._-]*$",
});

export type GeneratedMediaLocation = Static<typeof GeneratedMediaLocationSchema>;

export function createGeneratedMediaLocation(name: string): GeneratedMediaLocation {
    const location = posix.join("generated", name);
    if (!Value.Check(GeneratedMediaLocationSchema, location)) {
        throw new Error(`Invalid generated media location '${location}'.`);
    }
    return location;
}

export function resolveGeneratedMediaLocation(
    location: string,
    hostDirectory: string,
): string | undefined {
    if (!Value.Check(GeneratedMediaLocationSchema, location)) return undefined;
    return resolve(hostDirectory, location.slice("generated/".length));
}
