import { BaseCredential } from "@/core/BaseCredential.js";
import {
    GROK_OAUTH_SCOPE,
    getGrokAuthPath,
    isGrokAuthExpired,
    readGrokAuthStore,
    type GrokAuthRecord,
} from "@/vendors/grok/impl/auth.js";
import { writeGrokAuthRecord } from "@/vendors/grok/impl/writeGrokAuthRecord.js";

/** Refresh this far ahead of expiry so a request cannot race the cutoff. */
const EARLY_REFRESH_MS = 5 * 60 * 1_000;

export type GrokSessionCredentialValue = {
    readonly source: "session";
    token: string;
};

export interface GrokSessionCredentialLoadOptions {
    authFile?: string;
    env?: NodeJS.ProcessEnv;
}

export class GrokSessionCredential extends BaseCredential<
    "grok-session",
    GrokSessionCredentialValue
> {
    private readonly authPath: string;
    private record: GrokAuthRecord;
    private inFlight: Promise<boolean> | undefined;

    static async tryLoad(
        options: GrokSessionCredentialLoadOptions = {},
    ): Promise<GrokSessionCredential | null> {
        const env = options.env ?? process.env;
        const authPath = getGrokAuthPath({
            ...(options.authFile === undefined ? {} : { authFile: options.authFile }),
            env,
        });
        const store = await readGrokAuthStore(authPath);
        const session = store[GROK_OAUTH_SCOPE];
        if (typeof session?.key !== "string" || session.key.trim().length === 0) {
            return null;
        }

        return new GrokSessionCredential(
            { source: "session", token: session.key },
            authPath,
            session,
        );
    }

    /**
     * Renews the token before it is sent upstream when the stored expiry has passed or
     * is about to. Failure is not fatal: the request proceeds with the current token so
     * the upstream response decides the outcome.
     */
    async ensureFresh(options: { now?: number } = {}): Promise<void> {
        const expired = isGrokAuthExpired(this.record, {
            earlyInvalidationMs: EARLY_REFRESH_MS,
            ...(options.now === undefined ? {} : { now: options.now }),
        });
        if (!expired) return;
        await this.refresh();
    }

    async refreshAfterUnauthorized(): Promise<boolean> {
        return this.refresh();
    }

    /** Collapses concurrent callers onto one exchange so the refresh token is spent once. */
    private async refresh(): Promise<boolean> {
        this.inFlight ??= this.performRefresh().finally(() => {
            this.inFlight = undefined;
        });
        return this.inFlight;
    }

    private async performRefresh(): Promise<boolean> {
        const disk = (await this.readDisk())[GROK_OAUTH_SCOPE];
        if (
            typeof disk?.key === "string" &&
            disk.key !== this.credential.token &&
            !isGrokAuthExpired(disk)
        ) {
            this.credential.token = disk.key;
            this.record = disk;
            return true;
        }

        const record = disk ?? this.record;
        const refreshToken = stringField(record, "refresh_token");
        const issuer = stringField(record, "oidc_issuer");
        const clientId = stringField(record, "oidc_client_id");
        if (refreshToken === undefined || issuer === undefined || clientId === undefined) {
            return false;
        }

        const tokens = await requestGrokTokens(issuer, clientId, refreshToken);
        if (tokens === undefined) return false;

        const patch: GrokAuthRecord = {
            key: tokens.accessToken,
            ...(tokens.refreshToken === undefined ? {} : { refresh_token: tokens.refreshToken }),
            ...(tokens.expiresAt === undefined ? {} : { expires_at: tokens.expiresAt }),
        };
        this.credential.token = tokens.accessToken;
        this.record = { ...record, ...patch };
        try {
            await writeGrokAuthRecord(this.authPath, GROK_OAUTH_SCOPE, patch);
        } catch {
            // A refreshed token still works in memory when the store cannot be written.
        }
        return true;
    }

    private async readDisk(): Promise<Record<string, GrokAuthRecord>> {
        try {
            return await readGrokAuthStore(this.authPath);
        } catch {
            return {};
        }
    }

    private constructor(
        credential: GrokSessionCredentialValue,
        authPath: string,
        record: GrokAuthRecord,
    ) {
        super("grok-session", credential);
        this.authPath = authPath;
        this.record = record;
    }
}

async function requestGrokTokens(
    issuer: string,
    clientId: string,
    refreshToken: string,
): Promise<{ accessToken: string; expiresAt?: string; refreshToken?: string } | undefined> {
    try {
        const discovery = await fetch(
            `${issuer.replace(/\/$/u, "")}/.well-known/openid-configuration`,
        );
        if (!discovery.ok) return undefined;
        const metadata = (await discovery.json()) as { token_endpoint?: unknown };
        if (typeof metadata.token_endpoint !== "string") return undefined;

        const response = await fetch(metadata.token_endpoint, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "refresh_token",
                refresh_token: refreshToken,
                client_id: clientId,
            }),
        });
        if (!response.ok) return undefined;
        const tokens = (await response.json()) as {
            access_token?: unknown;
            expires_in?: unknown;
            refresh_token?: unknown;
        };
        if (typeof tokens.access_token !== "string" || tokens.access_token.length === 0) {
            return undefined;
        }
        return {
            accessToken: tokens.access_token,
            ...(typeof tokens.expires_in === "number" && Number.isFinite(tokens.expires_in)
                ? { expiresAt: new Date(Date.now() + tokens.expires_in * 1_000).toISOString() }
                : {}),
            ...(typeof tokens.refresh_token === "string" && tokens.refresh_token.length > 0
                ? { refreshToken: tokens.refresh_token }
                : {}),
        };
    } catch {
        return undefined;
    }
}

function stringField(record: GrokAuthRecord, name: string): string | undefined {
    const value = record[name];
    return typeof value === "string" && value.length > 0 ? value : undefined;
}
