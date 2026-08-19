import OpenAI, { APIError } from "openai";
import { bedrock } from "openai/providers/bedrock/aws";

import { isBedrockCredential, type CodexProviderCredential } from "@/vendors/VendorCredential.js";

/**
 * Bedrock's client, taught to keep the diagnostic AWS actually sent.
 *
 * The SDK builds an error message from a nested `error` object, which is the OpenAI envelope. AWS
 * reports a top-level `message` instead, so the SDK sees a body it does not recognize, discards
 * it, and says there was none. Presenting the body as the error preserves the only description of
 * the failure a person can act on.
 */
class MantleOpenAI extends OpenAI {
    protected override makeStatusError(
        status: number,
        body: object,
        message: string | undefined,
        headers: Headers,
    ): APIError {
        // The SDK reads the failure out of `body.error`, so an AWS body has to be moved there.
        const describesItself =
            typeof body === "object" &&
            body !== null &&
            !("error" in body) &&
            typeof (body as { message?: unknown }).message === "string";
        return super.makeStatusError(
            status,
            describesItself ? { error: body } : body,
            message,
            headers,
        );
    }
}

export function createCodexClient(options: {
    credential: CodexProviderCredential;
    endpoint: string;
    installationId: string;
    region: string;
    sessionId: string;
    userAgent: string;
    windowId: string;
}): OpenAI {
    if (isBedrockCredential(options.credential)) {
        const authentication =
            options.credential.name === "bedrock-bearer-token"
                ? { apiKey: options.credential.credential.bearerToken }
                : { credentialProvider: options.credential.credential.provider };
        return new MantleOpenAI({
            defaultHeaders: {
                "x-amzn-mantle-client-agent": "codex",
                "x-codex-beta-features": "remote_compaction_v2",
                originator: "codex_exec",
                "user-agent": options.userAgent,
                "session-id": options.sessionId,
                "thread-id": options.sessionId,
                "x-client-request-id": options.sessionId,
                "x-codex-installation-id": options.installationId,
                "x-codex-window-id": options.windowId,
            },
            maxRetries: 0,
            provider: bedrock({
                ...authentication,
                baseURL: options.endpoint,
                region: options.region,
            }),
        });
    }
    const accountId =
        options.credential.name === "codex-session"
            ? options.credential.credential.accountId
            : undefined;
    if (options.credential.name === "codex-session" && accountId === undefined) {
        throw new Error("Codex authentication is missing a ChatGPT account ID.");
    }
    return new OpenAI({
        apiKey:
            options.credential.name === "codex-session"
                ? options.credential.credential.accessToken
                : options.credential.credential.apiKey,
        baseURL:
            options.credential.name === "codex-session"
                ? `${options.endpoint.replace(/\/$/u, "")}/codex`
                : options.endpoint,
        defaultHeaders: {
            ...(accountId === undefined ? {} : { "chatgpt-account-id": accountId }),
            originator: "codex_exec",
            "user-agent": options.userAgent,
            "session-id": options.sessionId,
            "thread-id": options.sessionId,
            "x-client-request-id": options.sessionId,
            "x-codex-beta-features": "remote_compaction_v2",
            "x-codex-installation-id": options.installationId,
            "x-codex-window-id": options.windowId,
        },
        maxRetries: 0,
    });
}
