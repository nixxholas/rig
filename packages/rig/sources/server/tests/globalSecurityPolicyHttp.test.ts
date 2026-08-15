import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createTestRootContext } from "../../testing/createTestRootContext.js";

import { ProtocolHttpClient } from "../../client/ProtocolHttpClient.js";
import { GLOBAL_SECURITY_MD_MAX_BYTES } from "../../config/globalSecurityMdMaxBytes.js";
import { createTestSocketDirectory } from "../../testing/createTestSocketDirectory.js";
import { createProtocolHttpServer } from "../createProtocolHttpServer.js";

describe("global security policy over the local protocol", () => {
    it("reports no policy until the user writes one", async () => {
        const { client, close } = await startServer();
        try {
            await expect(client.getGlobalSecurityPolicy()).resolves.toEqual({ policy: "" });
        } finally {
            await close();
        }
    });

    it("stores the policy as SECURITY.md and reads it back", async () => {
        const { client, close, securityPath } = await startServer();
        try {
            await expect(
                client.updateGlobalSecurityPolicy({
                    policy: "Treat production deployments as high risk.\n",
                }),
            ).resolves.toEqual({
                policy: "Treat production deployments as high risk.\n",
            });
            await expect(readFile(securityPath, "utf8")).resolves.toBe(
                "Treat production deployments as high risk.\n",
            );
            expect((await stat(securityPath)).mode & 0o777).toBe(0o600);
            await expect(client.getGlobalSecurityPolicy()).resolves.toEqual({
                policy: "Treat production deployments as high risk.\n",
            });
        } finally {
            await close();
        }
    });

    it("reads policy changes made directly on disk", async () => {
        const { client, close, securityPath } = await startServer();
        try {
            await writeFile(securityPath, "Trust the internal deployment service.\n", "utf8");
            await expect(client.getGlobalSecurityPolicy()).resolves.toEqual({
                policy: "Trust the internal deployment service.\n",
            });
        } finally {
            await close();
        }
    });

    it("clears the policy when the user submits blank text", async () => {
        const { client, close, securityPath } = await startServer();
        try {
            await client.updateGlobalSecurityPolicy({ policy: "Keep this policy.\n" });
            await expect(client.updateGlobalSecurityPolicy({ policy: "   \n" })).resolves.toEqual({
                policy: "",
            });
            await expect(readFile(securityPath, "utf8")).resolves.toBe("");
            expect((await stat(securityPath)).mode & 0o777).toBe(0o600);
        } finally {
            await close();
        }
    });

    it("refuses policies larger than the allowed limit", async () => {
        const { client, close } = await startServer();
        try {
            await expect(
                client.updateGlobalSecurityPolicy({
                    policy: "x".repeat(GLOBAL_SECURITY_MD_MAX_BYTES + 1),
                }),
            ).rejects.toThrow("Global security policy must be smaller than 32 KB.");
        } finally {
            await close();
        }
    });

    it("accepts a byte-bounded policy even when JSON escaping expands the request", async () => {
        const { client, close } = await startServer();
        const policy = "\u0000".repeat(GLOBAL_SECURITY_MD_MAX_BYTES);
        try {
            await expect(client.updateGlobalSecurityPolicy({ policy })).resolves.toEqual({
                policy,
            });
        } finally {
            await close();
        }
    });

    it("refuses policies that are not text", async () => {
        const { client, close } = await startServer();
        try {
            await expect(
                client.updateGlobalSecurityPolicy({ policy: 7 as unknown as string }),
            ).rejects.toThrow("Global security policy must be text.");
        } finally {
            await close();
        }
    });
});

async function startServer(): Promise<{
    client: ProtocolHttpClient;
    close: () => Promise<void>;
    securityPath: string;
}> {
    const directory = await mkdtemp(join(tmpdir(), "rig-security-policy-test-"));
    const socketDirectory = await createTestSocketDirectory();
    const socketPath = join(socketDirectory, "server.sock");
    const securityPath = join(directory, "SECURITY.md");
    const server = await createProtocolHttpServer(createTestRootContext(), {
        globalSecurityPolicyPath: securityPath,
        token: "secret",
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
            server.off("error", reject);
            resolve();
        });
    });

    return {
        client: new ProtocolHttpClient({ socketPath, token: "secret" }),
        securityPath,
        async close() {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await Promise.all([
                rm(directory, { recursive: true, force: true }),
                rm(socketDirectory, { recursive: true, force: true }),
            ]);
        },
    };
}
