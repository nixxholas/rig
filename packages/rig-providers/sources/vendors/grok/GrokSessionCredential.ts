import { BaseCredential } from "@/core/BaseCredential.js";
import { unlink } from "node:fs/promises";
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
    recoveryAuthFile?: string;
}

export class GrokSessionCredential extends BaseCredential<
    "grok-session",
    GrokSessionCredentialValue
> {
    private authPath: string;
    private readonly recoveryAuthFile: string | undefined;
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
        let selectedAuthPath = authPath;
        if (options.recoveryAuthFile !== undefined) {
            const recovered = (await readGrokAuthStore(options.recoveryAuthFile))[GROK_OAUTH_SCOPE];
            if (recovered !== undefined) {
                try {
                    await writeGrokAuthRecord(authPath, GROK_OAUTH_SCOPE, recovered);
                    await unlink(options.recoveryAuthFile).catch(() => undefined);
                } catch {
                    selectedAuthPath = options.recoveryAuthFile;
                }
            }
        }
        const store = await readGrokAuthStore(selectedAuthPath);
        const session = store[GROK_OAUTH_SCOPE];
        if (typeof session?.key !== "string" || session.key.trim().length === 0) {
            return null;
        }

        return new GrokSessionCredential(
            { source: "session", token: session.key },
            selectedAuthPath,
            session,
            options.recoveryAuthFile,
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

    /** Refreshes an exported access lease only when its rotated owner state was saved durably. */
    async ensureFreshForLease(options: { now?: number } = {}): Promise<void> {
        const expired = isGrokAuthExpired(this.record, {
            earlyInvalidationMs: EARLY_REFRESH_MS,
            ...(options.now === undefined ? {} : { now: options.now }),
        });
        if (!expired) return;
        if (!(await this.refresh())) {
            throw new Error("Grok could not durably refresh the exported access-token lease.");
        }
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
        try {
            await writeGrokAuthRecord(this.authPath, GROK_OAUTH_SCOPE, patch);
        } catch {
            if (this.recoveryAuthFile === undefined || this.recoveryAuthFile === this.authPath) {
                return false;
            }
            try {
                await writeGrokAuthRecord(this.recoveryAuthFile, GROK_OAUTH_SCOPE, {
                    ...record,
                    ...patch,
                });
                this.authPath = this.recoveryAuthFile;
            } catch {
                return false;
            }
        }
        this.credential.token = tokens.accessToken;
        this.record = { ...record, ...patch };
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
        recoveryAuthFile?: string,
    ) {
        super("grok-session", credential);
        this.authPath = authPath;
        this.record = record;
        this.recoveryAuthFile = recoveryAuthFile;
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
