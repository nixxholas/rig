import {
    AnthropicProvider,
    ClaudeApiKeyCredential,
    ClaudeAuthTokenCredential,
    ClaudeCodeCredential,
    ClaudeOAuthCredential,
    CodexProvider,
    loadCodexCredential,
    type BaseProvider,
    type ProviderModelCompatibilityType,
} from "@slopus/happy-providers";

/** The vendors the real gym can exercise, each using that assistant's own local sign-in. */
export type RealGymVendor = "claude" | "codex";

export interface RealProvider {
    readonly provider: BaseProvider;
    readonly type: ProviderModelCompatibilityType;
    /** How the credential was found, so a report says which account answered. */
    readonly credential: string;
}

/**
 * Build a provider from the credentials the installed Codex or Claude Code assistant already
 * manages — the same order Rig itself resolves them in. Returns null when the user is not
 * signed in to that assistant, which is a skip rather than a failure.
 */
export async function loadRealProvider(vendor: RealGymVendor): Promise<RealProvider | null> {
    return vendor === "codex" ? await loadCodexProvider() : await loadClaudeProvider();
}

async function loadCodexProvider(): Promise<RealProvider | null> {
    const credential = await loadCodexCredential({ env: process.env });
    if (credential === null) return null;
    return {
        provider: new CodexProvider({ credential, parallelToolCalls: true }),
        type: "codex",
        credential: credential.name,
    };
}

async function loadClaudeProvider(): Promise<RealProvider | null> {
    const env = process.env;
    const credential =
        (await ClaudeApiKeyCredential.tryLoad({ env })) ??
        (await ClaudeAuthTokenCredential.tryLoad({ env })) ??
        (await ClaudeOAuthCredential.tryLoad({ env })) ??
        (await ClaudeCodeCredential.tryLoad({ env }));
    if (credential === null) return null;
    return {
        provider: new AnthropicProvider({ credential, env }),
        type: "claude",
        credential: credential.name,
    };
}
