import { Value } from "@sinclair/typebox/value";

import { projectGitSecretSchema } from "../protocol/index.js";

export function prepareRemoteWorkGitSecret(
    path: string,
    body: Uint8Array,
    secrets: { resolveSpecial(kind: "github"): NodeJS.ProcessEnv },
): Uint8Array | undefined {
    const pathname = new URL(path, "http://rig.local").pathname;
    let decoded: unknown;
    try {
        decoded = JSON.parse(Buffer.from(body).toString("utf8"));
    } catch {
        return undefined;
    }
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) return undefined;
    const decodedRecord = decoded as Record<string, unknown>;
    const hadTemporaryGitSecret = Object.hasOwn(decodedRecord, "temporaryGitSecret");
    const { temporaryGitSecret: _temporaryGitSecret, ...record } = decodedRecord;
    if (!remoteWorkRequestsGitHubCredential(pathname, record)) {
        return hadTemporaryGitSecret ? encode(record) : undefined;
    }

    let token: string | undefined;
    try {
        token = secrets.resolveSpecial("github").GH_TOKEN;
    } catch {
        return hadTemporaryGitSecret ? encode(record) : undefined;
    }
    if (token === undefined) return hadTemporaryGitSecret ? encode(record) : undefined;
    return encode({
        ...record,
        temporaryGitSecret: { kind: "github", token },
    });
}

function encode(value: Record<string, unknown>): Uint8Array {
    return Buffer.from(JSON.stringify(value), "utf8");
}

function remoteWorkRequestsGitHubCredential(
    pathname: string,
    body: Record<string, unknown>,
): boolean {
    if (pathname === "/projects/clone") {
        return (
            Value.Check(projectGitSecretSchema, body.secret) &&
            body.source !== null &&
            typeof body.source === "object" &&
            !Array.isArray(body.source) &&
            (body.source as Record<string, unknown>).kind === "github"
        );
    }
    if (/^\/projects\/[^/]+\/workspaces$/u.test(pathname)) {
        return Value.Check(projectGitSecretSchema, body.secret);
    }
    if (
        pathname === "/sessions" ||
        pathname === "/messages" ||
        /^\/sessions\/[^/]+\/(?:context|messages|steer)$/u.test(pathname)
    ) {
        return Value.Check(projectGitSecretSchema, body.gitSecret);
    }
    return false;
}
