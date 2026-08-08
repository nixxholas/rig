import { describe, expect, it } from "vitest";

import { createP2pInstanceIdentity } from "../p2p/P2pIdentity.js";
import {
    createLocalCredentialSnapshot,
    P2P_CREDENTIAL_AUTH_FILE_MAX_BYTES,
} from "./createLocalCredentialSnapshot.js";

const owner = createP2pInstanceIdentity("aownerinstance00000000001");

describe("createLocalCredentialSnapshot", () => {
    it("preserves enabled provider order and IDs, with P2P-safe configuration and visibility", async () => {
        const snapshot = await createLocalCredentialSnapshot({
            env: {
                AWS_BEARER_TOKEN_BEDROCK: "bedrock-from-env",
                AWS_REGION: "us-east-2",
                OPENAI_API_KEY: "codex-from-env",
            },
            owner,
            providers: {
                workCodex: {
                    baseUrl: "https://codex.example/v1",
                    enabled: true,
                    excludeModels: ["openai/gpt-5.4"],
                    includeModels: ["openai/gpt-5.6-sol"],
                    transport: "sse",
                    type: "codex",
                },
                sharedClaude: {
                    apiKey: "claude-from-config",
                    enabled: true,
                    p2pShare: "shared",
                    type: "claude",
                },
                disabledGrok: {
                    apiKey: "must-not-export",
                    enabled: true,
                    p2pShare: "disabled",
                    type: "grok",
                },
                bedrock: {
                    enabled: true,
                    modelOverrides: {
                        "openai/gpt-5.6-sol": { region: "us-east-1", transport: "mantle" },
                    },
                    region: "us-west-2",
                    searchModelId: "openai/gpt-5.6-sol",
                    type: "bedrock",
                },
            },
        });

        expect(snapshot.owner).toEqual({
            instanceId: owner.instanceId,
            publicKey: owner.publicKey,
        });
        expect(snapshot.providers).toEqual([
            {
                config: {
                    baseUrl: "https://codex.example/v1",
                    enabled: true,
                    excludeModels: ["openai/gpt-5.4"],
                    includeModels: ["openai/gpt-5.6-sol"],
                    transport: "sse",
                    type: "codex",
                },
                material: { apiKey: "codex-from-env", type: "codex" },
                providerId: "workCodex",
                visibility: "owner_only",
            },
            {
                config: { enabled: true, type: "claude" },
                material: { apiKey: "claude-from-config", type: "claude" },
                providerId: "sharedClaude",
                visibility: "shared",
            },
            {
                config: {
                    enabled: true,
                    modelOverrides: {
                        "openai/gpt-5.6-sol": { region: "us-east-1", transport: "mantle" },
                    },
                    region: "us-west-2",
                    searchModelId: "openai/gpt-5.6-sol",
                    type: "bedrock",
                },
                material: { bearerToken: "bedrock-from-env", type: "bedrock" },
                providerId: "bedrock",
                visibility: "owner_only",
            },
        ]);
    });

    it("prioritizes explicit credentials and exports bounded native Codex and Grok auth files", async () => {
        const files = new Map([
            ["/credentials/codex.json", '{"tokens":{"access_token":"codex-session"}}'],
            ["/credentials/grok.json", '{"https://auth.x.ai::scope":{"key":"grok-session"}}'],
        ]);
        const snapshot = await createLocalCredentialSnapshot({
            env: {
                ANTHROPIC_API_KEY: "claude-from-env",
                OPENAI_API_KEY: "codex-from-env",
                XAI_API_KEY: "grok-from-env",
            },
            owner,
            providers: {
                nativeCodex: {
                    authFile: "/credentials/codex.json",
                    enabled: true,
                    type: "codex",
                },
                nativeGrok: {
                    authFile: "/credentials/grok.json",
                    enabled: true,
                    type: "grok",
                },
                explicitClaude: {
                    apiKey: "claude-from-config",
                    enabled: true,
                    oauthToken: "oauth-from-config",
                    type: "claude",
                },
                explicitBedrock: {
                    bearerToken: "bedrock-from-config",
                    enabled: true,
                    type: "bedrock",
                },
            },
            readFile: async (path) => {
                const source = files.get(path);
                if (source === undefined) throw new Error("not found");
                return source;
            },
        });

        expect(snapshot.providers).toMatchObject([
            {
                material: { apiKey: "codex-from-env", type: "codex" },
                providerId: "nativeCodex",
            },
            {
                material: { apiKey: "grok-from-env", type: "grok" },
                providerId: "nativeGrok",
            },
            {
                material: { oauthToken: "oauth-from-config", type: "claude" },
                providerId: "explicitClaude",
            },
            {
                material: { bearerToken: "bedrock-from-config", type: "bedrock" },
                providerId: "explicitBedrock",
            },
        ]);

        const nativeOnly = await createLocalCredentialSnapshot({
            owner,
            providers: {
                nativeCodex: {
                    authFile: "/credentials/codex.json",
                    enabled: true,
                    type: "codex",
                },
                nativeGrok: {
                    authFile: "/credentials/grok.json",
                    enabled: true,
                    type: "grok",
                },
            },
            readFile: async (path) => {
                const source = files.get(path);
                if (source === undefined) throw new Error("not found");
                return source;
            },
        });
        expect(nativeOnly.providers).toMatchObject([
            {
                material: { accessToken: "codex-session", type: "codex" },
                providerId: "nativeCodex",
            },
            {
                material: { accessToken: "grok-session", type: "grok" },
                providerId: "nativeGrok",
            },
        ]);
    });

    it("omits unavailable credentials and auth files above the encrypted material limit", async () => {
        const snapshot = await createLocalCredentialSnapshot({
            homeDirectory: "/home/steve",
            owner,
            providers: {
                oversizedCodex: { enabled: true, type: "codex" },
                unavailableClaude: { enabled: true, type: "claude" },
                disabledBedrock: { enabled: false, type: "bedrock" },
            },
            readClaudeOAuthToken: async () => undefined,
            readFile: async (path) => {
                expect(path).toBe("/home/steve/.codex/auth.json");
                return "x".repeat(P2P_CREDENTIAL_AUTH_FILE_MAX_BYTES + 1);
            },
        });

        expect(snapshot.providers).toEqual([]);
    });

    it("exports an API key stored by a native Codex API-key login", async () => {
        const snapshot = await createLocalCredentialSnapshot({
            owner,
            providers: {
                codex: {
                    authFile: "/credentials/codex.json",
                    enabled: true,
                    type: "codex",
                },
            },
            readFile: async () =>
                JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "native-api-key" }),
        });

        expect(snapshot.providers).toMatchObject([
            {
                material: { apiKey: "native-api-key", type: "codex" },
                providerId: "codex",
            },
        ]);
    });

    it("exports a native Claude OAuth credential using the configured Claude directory", async () => {
        let observedEnvironment: NodeJS.ProcessEnv | undefined;
        const snapshot = await createLocalCredentialSnapshot({
            owner,
            providers: {
                claude: {
                    configDir: "/credentials/claude",
                    enabled: true,
                    type: "claude",
                },
            },
            readClaudeOAuthToken: async ({ env }) => {
                observedEnvironment = env;
                return "native-claude-oauth";
            },
        });

        expect(observedEnvironment?.CLAUDE_CONFIG_DIR).toBe("/credentials/claude");
        expect(snapshot.providers).toMatchObject([
            {
                material: { oauthToken: "native-claude-oauth", type: "claude" },
                providerId: "claude",
            },
        ]);
    });

    it("exports only the native Claude access token when its credential file is available", async () => {
        const credentials =
            '{"claudeAiOauth":{"accessToken":"access","refreshToken":"refresh","expiresAt":1}}';
        const snapshot = await createLocalCredentialSnapshot({
            homeDirectory: "/home/steve",
            owner,
            providers: { claude: { enabled: true, type: "claude" } },
            readFile: async (path) => {
                if (path !== "/home/steve/.claude/.credentials.json") {
                    throw new Error("not found");
                }
                return credentials;
            },
        });

        expect(snapshot.providers).toMatchObject([
            {
                material: { oauthToken: "access", type: "claude" },
                providerId: "claude",
            },
        ]);
    });
});
