import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const tokenSchema = Type.String({
    minLength: 43,
    maxLength: 43,
    pattern: "^[A-Za-z0-9_-]+$",
});
type Token = Static<typeof tokenSchema>;

export async function readOrCreateAgentToken(tokenPath: string): Promise<Token> {
    const existing = await readToken(tokenPath);
    if (existing !== undefined) {
        await chmod(tokenPath, 0o600);
        return existing;
    }
    const token = randomBytes(32).toString("base64url");
    if (!Value.Check(tokenSchema, token)) {
        throw new Error("The generated daemon token is invalid.");
    }
    const temporaryPath = join(
        dirname(tokenPath),
        `.${tokenPath.split("/").at(-1) ?? "token"}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
    );
    try {
        await writeFile(temporaryPath, `${token}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await chmod(temporaryPath, 0o600);
        await rename(temporaryPath, tokenPath);
        await chmod(tokenPath, 0o600);
    } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
    } finally {
        await unlink(temporaryPath).catch(() => undefined);
    }
    const persisted = await readToken(tokenPath);
    if (persisted === undefined) {
        throw new Error("The daemon token could not be persisted.");
    }
    return persisted;
}

export function isAuthorizedAgentRequest(
    authorization: string | readonly string[] | undefined,
    expectedToken: string,
): boolean {
    const value = Array.isArray(authorization) ? authorization.at(-1) : authorization;
    if (value === undefined || !value.startsWith("Bearer ")) return false;
    const supplied = value.slice("Bearer ".length);
    const expected = Buffer.from(expectedToken, "utf8");
    const actual = Buffer.from(supplied, "utf8");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readToken(path: string): Promise<Token | undefined> {
    try {
        const value = (await readFile(path, "utf8")).trim();
        return Value.Check(tokenSchema, value) ? value : undefined;
    } catch {
        return undefined;
    }
}
