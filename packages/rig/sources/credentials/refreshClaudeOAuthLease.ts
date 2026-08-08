import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const execFileAsync = promisify(execFile);
const REFRESH_EARLY_MS = 5 * 60 * 1_000;
const KEYCHAIN_TIMEOUT_MS = 2_000;
const SECURITY_STDIN_LINE_LIMIT = 4_096 - 64;
const DEFAULT_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const DEFAULT_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const ALLOWED_CUSTOM_OAUTH_BASES = new Set([
    "https://beacon.claude-ai.staging.ant.dev",
    "https://claude.fedstart.com",
    "https://claude-staging.fedstart.com",
]);
const SCOPES = [
    "user:profile",
    "user:inference",
    "user:sessions:claude_code",
    "user:mcp_servers",
    "user:file_upload",
].join(" ");

const claudeOAuthSchema = Type.Object(
    {
        accessToken: Type.String({ minLength: 1 }),
        expiresAt: Type.Optional(Type.Number()),
        refreshToken: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: true },
);
const credentialDocumentSchema = Type.Object(
    { claudeAiOauth: Type.Optional(claudeOAuthSchema) },
    { additionalProperties: true },
);
const refreshResponseSchema = Type.Object(
    {
        access_token: Type.String({ minLength: 1 }),
        expires_in: Type.Number({ minimum: 1 }),
        refresh_token: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: true },
);
type CredentialDocument = Static<typeof credentialDocumentSchema>;
type RefreshResponse = Static<typeof refreshResponseSchema>;

export interface RefreshClaudeOAuthLeaseOptions {
    configDirectory: string;
    env: NodeJS.ProcessEnv;
    fetch?: typeof fetch;
    now?: () => number;
    platform?: NodeJS.Platform;
    recoveryPath?: string;
}

/**
 * Returns a current Claude OAuth access-token lease while keeping refresh authority on its owner.
 *
 * Claude Code's native secure storage is refreshed in place. Only the resulting access token is
 * handed to P2P replication; the refresh token never leaves this Rig.
 */
export async function refreshClaudeOAuthLease(
    options: RefreshClaudeOAuthLeaseOptions,
): Promise<string | undefined> {
    const explicit = nonEmpty(options.env.CLAUDE_CODE_OAUTH_TOKEN);
    if (explicit !== undefined) return explicit;
    const storage = await readStorage(options);
    const recovered = await readRecovery(options.recoveryPath);
    if (storage === undefined && recovered === undefined) return undefined;
    const document = recovered ?? storage!.document;
    if (recovered !== undefined && storage !== undefined) {
        try {
            await storage.write(recovered);
            if (options.recoveryPath !== undefined) {
                await rm(options.recoveryPath, { force: true });
            }
        } catch {
            // The recovery journal remains authoritative until native storage can be repaired.
        }
    }
    const oauth = document.claudeAiOauth;
    if (oauth === undefined) return undefined;
    const now = options.now?.() ?? Date.now();
    if (
        oauth.expiresAt === undefined ||
        oauth.expiresAt > now + REFRESH_EARLY_MS ||
        oauth.refreshToken === undefined
    ) {
        return oauth.accessToken;
    }

    const response = await refresh(oauth.refreshToken, options).catch(() => undefined);
    if (response === undefined) return oauth.accessToken;
    const updated: CredentialDocument = {
        ...document,
        claudeAiOauth: {
            ...oauth,
            accessToken: response.access_token,
            expiresAt: now + response.expires_in * 1_000,
            refreshToken: response.refresh_token ?? oauth.refreshToken,
        },
    };
    // A rotated refresh token is not usable until its owner has durably stored it. Returning the
    // access lease after a failed write would leave both local and remote inference stranded when
    // that lease expires.
    try {
        if (storage === undefined)
            throw new Error("Claude native credential storage is unavailable.");
        await storage.write(updated);
        if (options.recoveryPath !== undefined) {
            await rm(options.recoveryPath, { force: true });
        }
    } catch (error) {
        if (options.recoveryPath === undefined) throw error;
        await writeFileAtomically(options.recoveryPath, JSON.stringify(updated));
    }
    return response.access_token;
}

async function readRecovery(path: string | undefined): Promise<CredentialDocument | undefined> {
    if (path === undefined) return undefined;
    try {
        return parseDocument(await readFile(path, "utf8"));
    } catch {
        return undefined;
    }
}

async function refresh(
    refreshToken: string,
    options: RefreshClaudeOAuthLeaseOptions,
): Promise<RefreshResponse | undefined> {
    const customBase = nonEmpty(options.env.CLAUDE_CODE_CUSTOM_OAUTH_URL)?.replace(/\/$/u, "");
    if (customBase !== undefined && !ALLOWED_CUSTOM_OAUTH_BASES.has(customBase)) return undefined;
    const response = await (options.fetch ?? fetch)(
        customBase === undefined ? DEFAULT_TOKEN_URL : `${customBase}/v1/oauth/token`,
        {
            body: JSON.stringify({
                client_id: nonEmpty(options.env.CLAUDE_CODE_OAUTH_CLIENT_ID) ?? DEFAULT_CLIENT_ID,
                grant_type: "refresh_token",
                refresh_token: refreshToken,
                scope: SCOPES,
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
            signal: AbortSignal.timeout(15_000),
        },
    );
    if (!response.ok) return undefined;
    const value: unknown = await response.json();
    return Value.Check(refreshResponseSchema, value) ? value : undefined;
}

async function readStorage(options: RefreshClaudeOAuthLeaseOptions): Promise<
    | {
          document: CredentialDocument;
          write: (document: CredentialDocument) => Promise<void>;
      }
    | undefined
> {
    if ((options.platform ?? process.platform) === "darwin") {
        const keychain = await readKeychain(options);
        if (keychain !== undefined) return keychain;
    }
    const path = join(options.configDirectory, ".credentials.json");
    try {
        const source = await readFile(path, "utf8");
        const document = parseDocument(source);
        if (document === undefined) return undefined;
        return {
            document,
            write: (updated) => writeFileAtomically(path, JSON.stringify(updated)),
        };
    } catch {
        return undefined;
    }
}

async function readKeychain(options: RefreshClaudeOAuthLeaseOptions): Promise<
    | {
          document: CredentialDocument;
          write: (document: CredentialDocument) => Promise<void>;
      }
    | undefined
> {
    const defaultDirectory = options.env.CLAUDE_CONFIG_DIR === undefined;
    const directorySuffix = defaultDirectory
        ? ""
        : `-${createHash("sha256").update(options.configDirectory).digest("hex").slice(0, 8)}`;
    const oauthSuffix = options.env.CLAUDE_CODE_CUSTOM_OAUTH_URL ? "-custom-oauth" : "";
    const service = `Claude Code${oauthSuffix}-credentials${directorySuffix}`;
    const account = userInfo().username;
    try {
        const { stdout } = await execFileAsync(
            "security",
            ["find-generic-password", "-a", account, "-w", "-s", service],
            { encoding: "utf8", killSignal: "SIGKILL", timeout: KEYCHAIN_TIMEOUT_MS },
        );
        const document = parseDocument(stdout);
        if (document === undefined) return undefined;
        return {
            document,
            write: (updated) => writeKeychain(account, service, JSON.stringify(updated)),
        };
    } catch {
        return undefined;
    }
}

async function writeKeychain(account: string, service: string, source: string): Promise<void> {
    const hex = Buffer.from(source, "utf8").toString("hex");
    const command = `add-generic-password -U -a "${account}" -s "${service}" -X "${hex}"\n`;
    if (command.length > SECURITY_STDIN_LINE_LIMIT) {
        await execFileAsync(
            "security",
            ["add-generic-password", "-U", "-a", account, "-s", service, "-X", hex],
            { killSignal: "SIGKILL", timeout: KEYCHAIN_TIMEOUT_MS },
        );
        return;
    }
    await new Promise<void>((resolve, reject) => {
        const child = spawn("security", ["-i"], { stdio: ["pipe", "ignore", "ignore"] });
        child.once("error", reject);
        child.once("exit", (code) =>
            code === 0 ? resolve() : reject(new Error("Claude credential keychain update failed.")),
        );
        child.stdin.end(command);
    });
}

async function writeFileAtomically(path: string, source: string): Promise<void> {
    const temporary = `${path}.${randomUUID()}.rig-refresh`;
    try {
        await mkdir(dirname(path), { mode: 0o700, recursive: true });
        await writeFile(temporary, source, { mode: 0o600 });
        await chmod(temporary, 0o600);
        await rename(temporary, path);
    } finally {
        await rm(temporary, { force: true });
    }
}

function parseDocument(source: string): CredentialDocument | undefined {
    try {
        const value: unknown = JSON.parse(source);
        return Value.Check(credentialDocumentSchema, value) ? value : undefined;
    } catch {
        return undefined;
    }
}

function nonEmpty(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}
