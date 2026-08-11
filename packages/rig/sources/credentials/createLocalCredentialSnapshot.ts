import { readFile as readFileFromDisk } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { CodexSessionCredential, GrokSessionCredential } from "@slopus/happy-providers";

import type { ConfigProviders } from "../config/types.js";
import type { P2pPeerIdentity } from "../protocol/P2pIdentityProtocol.js";
import type {
    P2pCredentialMaterial,
    P2pCredentialSnapshot,
    ProvisionedProvider,
} from "../protocol/P2pCredentialProtocol.js";
import { P2P_CREDENTIAL_SNAPSHOT_MAX_BYTES } from "../protocol/P2pCredentialProtocol.js";
import { refreshClaudeOAuthLease } from "./refreshClaudeOAuthLease.js";

export const P2P_CREDENTIAL_AUTH_FILE_MAX_BYTES = 2 * 1024 * 1024;

const nullableStringSchema = Type.Union([Type.String(), Type.Null()]);
const codexAuthFileSchema = Type.Object(
    {
        OPENAI_API_KEY: Type.Optional(nullableStringSchema),
        tokens: Type.Optional(
            Type.Union([
                Type.Object(
                    {
                        access_token: Type.Optional(nullableStringSchema),
                        account_id: Type.Optional(nullableStringSchema),
                    },
                    { additionalProperties: true },
                ),
                Type.Null(),
            ]),
        ),
    },
    { additionalProperties: true },
);
const grokAuthFileSchema = Type.Record(
    Type.String(),
    Type.Object(
        {
            auth_mode: Type.Optional(Type.String()),
            create_time: Type.Optional(Type.String()),
            expires_at: Type.Optional(Type.String()),
            key: Type.Optional(Type.String()),
        },
        { additionalProperties: true },
    ),
);
const claudeCredentialsSchema = Type.Object(
    {
        claudeAiOauth: Type.Optional(
            Type.Object(
                { accessToken: Type.Optional(Type.String()) },
                { additionalProperties: true },
            ),
        ),
    },
    { additionalProperties: true },
);
type CodexAuthFile = Static<typeof codexAuthFileSchema>;
type GrokAuthFile = Static<typeof grokAuthFileSchema>;
type ClaudeCredentials = Static<typeof claudeCredentialsSchema>;

export interface CreateLocalCredentialSnapshotOptions {
    credentialRecoveryDirectory?: string;
    env?: NodeJS.ProcessEnv;
    homeDirectory?: string;
    owner: P2pPeerIdentity;
    providers: ConfigProviders;
    readClaudeOAuthToken?: (options: { env: NodeJS.ProcessEnv }) => Promise<string | undefined>;
    readFile?: (path: string) => Promise<string>;
}

/**
 * Produces the ordered credential snapshot a Rig supplies to a trusted peer.
 *
 * Only material that can actually authenticate a configured provider is
 * included. Secret paths and local executable paths deliberately never cross the P2P boundary:
 * refreshable native records stay with their owner and only access leases travel encrypted.
 */
export async function createLocalCredentialSnapshot(
    options: CreateLocalCredentialSnapshotOptions,
): Promise<P2pCredentialSnapshot> {
    const env = options.env ?? process.env;
    const homeDirectory = options.homeDirectory ?? homedir();
    const readFile = options.readFile ?? ((path: string) => readFileFromDisk(path, "utf8"));
    const refreshNativeCredentials = options.readFile === undefined;
    const readClaudeOAuthToken =
        options.readClaudeOAuthToken ??
        ((input: { env: NodeJS.ProcessEnv }) =>
            options.readFile === undefined
                ? refreshClaudeOAuthLease({
                      configDirectory:
                          input.env.CLAUDE_CONFIG_DIR?.trim() || join(homeDirectory, ".claude"),
                      env: input.env,
                      ...(options.credentialRecoveryDirectory === undefined
                          ? {}
                          : {
                                recoveryPath: join(
                                    options.credentialRecoveryDirectory,
                                    `claude-${Buffer.from(
                                        input.env.CLAUDE_CONFIG_DIR?.trim() ||
                                            join(homeDirectory, ".claude"),
                                    ).toString("base64url")}.json`,
                                ),
                            }),
                  })
                : defaultReadClaudeOAuthToken({
                      env: input.env,
                      homeDirectory,
                      readFile,
                  }));
    const providers: ProvisionedProvider[] = [];

    for (const [providerId, provider] of Object.entries(options.providers)) {
        if (!provider.enabled || provider.p2pShare === "disabled") continue;
        const visibility = provider.p2pShare ?? "owner_only";
        const material = await materialForProvider({
            ...(options.credentialRecoveryDirectory === undefined
                ? {}
                : { credentialRecoveryDirectory: options.credentialRecoveryDirectory }),
            env,
            homeDirectory,
            provider,
            readClaudeOAuthToken,
            readFile,
            refreshNativeCredentials,
        });
        if (material === undefined) continue;
        providers.push({
            config: providerConfig(provider, env),
            material,
            providerId,
            visibility,
        } as ProvisionedProvider);
    }

    const snapshot: P2pCredentialSnapshot = {
        owner: {
            instanceId: options.owner.instanceId,
            publicKey: options.owner.publicKey,
        },
        providers,
        version: 1,
    };
    if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > P2P_CREDENTIAL_SNAPSHOT_MAX_BYTES) {
        throw new Error("The local inference credential snapshot exceeds the 5 MiB limit.");
    }
    return snapshot;
}

function providerConfig(
    provider: ConfigProviders[string],
    env: NodeJS.ProcessEnv,
): ProvisionedProvider["config"] {
    const common = {
        enabled: provider.enabled,
        ...(provider.excludeModels === undefined
            ? {}
            : { excludeModels: [...provider.excludeModels] }),
        ...(provider.includeModels === undefined
            ? {}
            : { includeModels: [...provider.includeModels] }),
    };
    if (provider.type === "codex") {
        const baseUrl = provider.baseUrl ?? nonEmpty(env.RIG_CODEX_BASE_URL);
        const environmentTransport = env.RIG_CODEX_TRANSPORT;
        const transport =
            provider.transport ??
            (environmentTransport === "auto" ||
            environmentTransport === "sse" ||
            environmentTransport === "websocket" ||
            environmentTransport === "websocket-cached"
                ? environmentTransport
                : undefined);
        return {
            ...common,
            ...(baseUrl === undefined ? {} : { baseUrl }),
            ...(transport === undefined ? {} : { transport }),
            type: "codex",
        };
    }
    if (provider.type === "claude") return { ...common, type: "claude" };
    if (provider.type === "grok") {
        const baseUrl = provider.baseUrl ?? nonEmpty(env.RIG_GROK_BASE_URL);
        return {
            ...common,
            ...(baseUrl === undefined ? {} : { baseUrl }),
            type: "grok",
        };
    }
    if (provider.type === "bedrock") {
        const region =
            provider.region ?? nonEmpty(env.AWS_REGION) ?? nonEmpty(env.AWS_DEFAULT_REGION);
        return {
            ...common,
            ...(provider.modelOverrides === undefined
                ? {}
                : { modelOverrides: provider.modelOverrides }),
            ...(region === undefined ? {} : { region }),
            ...(provider.searchModelId === undefined
                ? {}
                : { searchModelId: provider.searchModelId }),
            type: "bedrock",
        };
    }
    provider satisfies never;
    throw new Error("The configured provider type is unsupported.");
}

async function materialForProvider(options: {
    credentialRecoveryDirectory?: string;
    env: NodeJS.ProcessEnv;
    homeDirectory: string;
    provider: ConfigProviders[string];
    readClaudeOAuthToken: (options: { env: NodeJS.ProcessEnv }) => Promise<string | undefined>;
    readFile: (path: string) => Promise<string>;
    refreshNativeCredentials: boolean;
}): Promise<P2pCredentialMaterial | undefined> {
    const {
        env,
        homeDirectory,
        provider,
        readClaudeOAuthToken,
        readFile,
        refreshNativeCredentials,
    } = options;
    if (provider.type === "codex") {
        const apiKey = nonEmpty(provider.apiKey) ?? nonEmpty(env.OPENAI_API_KEY);
        if (apiKey !== undefined) return { apiKey, type: "codex" };
        const authFile = provider.authFile ?? codexAuthPath(env, homeDirectory);
        if (refreshNativeCredentials) {
            const loaded = await CodexSessionCredential.tryLoad({ authFile, env }).catch(
                () => null,
            );
            const credential =
                loaded !== null && accessTokenExpiresSoon(loaded.credential.accessToken)
                    ? ((await loaded.refreshForUnauthorized().catch(() => undefined)) ?? loaded)
                    : loaded;
            if (credential !== null) {
                return {
                    accessToken: credential.credential.accessToken,
                    ...(credential.credential.accountId === undefined
                        ? {}
                        : { accountId: credential.credential.accountId }),
                    type: "codex",
                };
            }
        }
        const source = await readBoundedAuthFile(authFile, readFile, isCodexAuthFile);
        return source === undefined ? undefined : codexLeaseMaterial(source);
    }
    if (provider.type === "grok") {
        const apiKey = nonEmpty(provider.apiKey) ?? nonEmpty(env.XAI_API_KEY);
        if (apiKey !== undefined) return { apiKey, type: "grok" };
        const authFile = provider.authFile ?? grokAuthPath(env, homeDirectory);
        if (refreshNativeCredentials) {
            const credential = await GrokSessionCredential.tryLoad({
                authFile,
                env,
                ...(options.credentialRecoveryDirectory === undefined
                    ? {}
                    : {
                          recoveryAuthFile: join(
                              options.credentialRecoveryDirectory,
                              `grok-${Buffer.from(authFile).toString("base64url")}.json`,
                          ),
                      }),
            }).catch(() => null);
            if (credential !== null) {
                await credential.ensureFreshForLease();
                return { accessToken: credential.credential.token, type: "grok" };
            }
        }
        const source = await readBoundedAuthFile(authFile, readFile, isGrokAuthFile);
        return source === undefined ? undefined : grokLeaseMaterial(source);
    }
    if (provider.type === "claude") {
        const oauthToken = nonEmpty(provider.oauthToken);
        if (oauthToken !== undefined) return { oauthToken, type: "claude" };
        const apiKey = nonEmpty(provider.apiKey) ?? nonEmpty(env.ANTHROPIC_API_KEY);
        if (apiKey !== undefined) return { apiKey, type: "claude" };
        const authToken = nonEmpty(provider.authToken) ?? nonEmpty(env.ANTHROPIC_AUTH_TOKEN);
        if (authToken !== undefined) return { authToken, type: "claude" };
        const environmentOAuthToken = nonEmpty(env.CLAUDE_CODE_OAUTH_TOKEN);
        if (environmentOAuthToken !== undefined)
            return { oauthToken: environmentOAuthToken, type: "claude" };
        const oauthEnvironment = {
            ...env,
            ...(provider.configDir === undefined ? {} : { CLAUDE_CONFIG_DIR: provider.configDir }),
        };
        const nativeOAuthToken = nonEmpty(await readClaudeOAuthToken({ env: oauthEnvironment }));
        return nativeOAuthToken === undefined
            ? undefined
            : { oauthToken: nativeOAuthToken, type: "claude" };
    }
    if (provider.type === "bedrock") {
        const bearerToken =
            nonEmpty(provider.bearerToken) ??
            nonEmpty(env[provider.bearerTokenEnvVar ?? "AWS_BEARER_TOKEN_BEDROCK"]);
        return bearerToken === undefined ? undefined : { bearerToken, type: "bedrock" };
    }
    provider satisfies never;
    throw new Error("The configured provider type is unsupported.");
}

function codexAuthPath(env: NodeJS.ProcessEnv, homeDirectory: string): string {
    const codexHome = nonEmpty(env.CODEX_HOME);
    return join(
        codexHome ?? homeDirectory,
        codexHome === undefined ? ".codex/auth.json" : "auth.json",
    );
}

function grokAuthPath(env: NodeJS.ProcessEnv, homeDirectory: string): string {
    const grokHome = nonEmpty(env.GROK_HOME);
    return join(
        grokHome ?? homeDirectory,
        grokHome === undefined ? ".grok/auth.json" : "auth.json",
    );
}

async function readBoundedAuthFile(
    path: string,
    readFile: (path: string) => Promise<string>,
    isUsable: (source: string) => boolean,
): Promise<string | undefined> {
    try {
        const source = await readFile(path);
        return Buffer.byteLength(source, "utf8") > P2P_CREDENTIAL_AUTH_FILE_MAX_BYTES ||
            source.trim().length === 0 ||
            !isUsable(source)
            ? undefined
            : source;
    } catch {
        return undefined;
    }
}

function nonEmpty(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function isCodexAuthFile(source: string): boolean {
    const parsed: unknown = parseJson(source);
    if (!Value.Check(codexAuthFileSchema, parsed)) return false;
    const auth = parsed as CodexAuthFile;
    return (
        nonEmpty(auth.OPENAI_API_KEY ?? undefined) !== undefined ||
        nonEmpty(auth.tokens?.access_token ?? undefined) !== undefined
    );
}

function isGrokAuthFile(source: string): boolean {
    const parsed: unknown = parseJson(source);
    if (!Value.Check(grokAuthFileSchema, parsed)) return false;
    return Object.values(parsed as GrokAuthFile).some(
        (record) => nonEmpty(record.key) !== undefined,
    );
}

async function defaultReadClaudeOAuthToken(options: {
    env: NodeJS.ProcessEnv;
    homeDirectory: string;
    readFile: (path: string) => Promise<string>;
}): Promise<string | undefined> {
    const environmentToken = nonEmpty(options.env.CLAUDE_CODE_OAUTH_TOKEN);
    if (environmentToken !== undefined) return environmentToken;
    const configDirectory =
        nonEmpty(options.env.CLAUDE_CONFIG_DIR) ?? join(options.homeDirectory, ".claude");
    try {
        const source = await options.readFile(join(configDirectory, ".credentials.json"));
        const parsed: unknown = JSON.parse(source);
        if (Value.Check(claudeCredentialsSchema, parsed)) {
            return nonEmpty((parsed as ClaudeCredentials).claudeAiOauth?.accessToken);
        }
    } catch {
        // Native credentials are optional. A local unreadable credential must
        // not prevent the other usable providers from synchronizing.
    }
    return undefined;
}

function codexLeaseMaterial(source: string): P2pCredentialMaterial | undefined {
    const parsed = parseJson(source);
    if (!Value.Check(codexAuthFileSchema, parsed)) return undefined;
    const auth = parsed as CodexAuthFile;
    const apiKey = nonEmpty(auth.OPENAI_API_KEY ?? undefined);
    if (apiKey !== undefined) return { apiKey, type: "codex" };
    const accessToken = nonEmpty(auth.tokens?.access_token ?? undefined);
    if (accessToken === undefined) return undefined;
    const accountId = nonEmpty(auth.tokens?.account_id ?? undefined);
    return {
        accessToken,
        ...(accountId === undefined ? {} : { accountId }),
        type: "codex",
    };
}

function grokLeaseMaterial(source: string): P2pCredentialMaterial | undefined {
    const parsed = parseJson(source);
    if (!Value.Check(grokAuthFileSchema, parsed)) return undefined;
    const entries = Object.entries(parsed as GrokAuthFile);
    const apiKey = entries.find(
        ([scope, record]) => scope.includes("api_key") || record.auth_mode === "api_key",
    )?.[1].key;
    if (nonEmpty(apiKey) !== undefined) return { apiKey: nonEmpty(apiKey)!, type: "grok" };
    const session = entries.find(([, record]) => nonEmpty(record.key) !== undefined)?.[1];
    const accessToken = nonEmpty(session?.key);
    if (accessToken === undefined) return undefined;
    return {
        accessToken,
        ...(nonEmpty(session?.create_time) === undefined
            ? {}
            : { createdAt: nonEmpty(session?.create_time)! }),
        ...(nonEmpty(session?.expires_at) === undefined
            ? {}
            : { expiresAt: nonEmpty(session?.expires_at)! }),
        type: "grok",
    };
}

function parseJson(source: string): unknown {
    try {
        return JSON.parse(source);
    } catch {
        return undefined;
    }
}

function accessTokenExpiresSoon(token: string, now = Date.now()): boolean {
    const payload = token.split(".")[1];
    if (payload === undefined) return false;
    try {
        const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        if (
            decoded === null ||
            typeof decoded !== "object" ||
            !("exp" in decoded) ||
            typeof decoded.exp !== "number"
        ) {
            return false;
        }
        return decoded.exp * 1_000 <= now + 5 * 60 * 1_000;
    } catch {
        return false;
    }
}
