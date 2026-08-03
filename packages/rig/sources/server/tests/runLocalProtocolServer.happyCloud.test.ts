import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ProtocolHttpClient } from "../../client/ProtocolHttpClient.js";
import { HAPPY_CLOUD_CONTRACT_VERSION } from "../../protocol/index.js";
import { createTestSocketDirectory } from "../../testing/createTestSocketDirectory.js";
import { prepareLocalServerDirectory } from "../prepareLocalServerDirectory.js";
import { runLocalProtocolServer } from "../runLocalProtocolServer.js";
import { writeLocalServerToken } from "../writeLocalServerToken.js";

const roots = new Set<string>();

afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all([...roots].map((root) => rm(root, { force: true, recursive: true })));
    roots.clear();
});

describe("runLocalProtocolServer Happy Cloud topology", () => {
    it("uses the session store database owner and restores enrollment after daemon restart", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-server-happy-cloud-"));
        const socketDirectory = await createTestSocketDirectory();
        roots.add(root);
        roots.add(socketDirectory);
        const serverDirectory = join(root, "server");
        const configDirectory = join(root, "config");
        const rigHome = join(root, "home", ".happy", "rig");
        await Promise.all([
            prepareLocalServerDirectory(serverDirectory),
            mkdir(configDirectory, { recursive: true }),
            mkdir(rigHome, { recursive: true }),
        ]);
        await writeFile(
            join(configDirectory, "happy.toml"),
            "[providers]\ndefault_enable = false\n\n[providers.bedrock]\nenabled = true\n",
        );
        vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "test-token");
        vi.stubEnv("RIG_CONFIGURATION_DIRECTORY", configDirectory);
        vi.stubEnv("RIG_HOME", rigHome);
        vi.stubEnv("RIG_SERVER_DIRECTORY", serverDirectory);
        const tokenPath = join(serverDirectory, "token");
        const socketPath = join(socketDirectory, "server.sock");
        const token = await writeLocalServerToken(tokenPath);

        const first = runLocalProtocolServer({
            happyIntegration: "disabled",
            socketPath,
            tokenPath,
        });
        const client = new ProtocolHttpClient({ socketPath, token });
        await waitForReady(client);
        await client.applyHappyCloudCommand({
            action: "set_enrollment",
            contractVersion: HAPPY_CLOUD_CONTRACT_VERSION,
            expectedVersion: 0,
            mutationId: "production-enrollment",
            state: "enrolled",
        });
        await client.shutdown();
        await first;

        const restarted = runLocalProtocolServer({
            happyIntegration: "disabled",
            socketPath,
            tokenPath,
        });
        await waitForReady(client);
        await expect(client.getHappyCloudStatus()).resolves.toMatchObject({
            authority: "local_record_only",
            enrollment: { state: "enrolled" },
            version: 1,
        });
        await client.shutdown();
        await restarted;
    }, 60_000);
});

async function waitForReady(client: ProtocolHttpClient): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        let health;
        try {
            health = await client.health();
        } catch {
            // The Unix socket may not be accepting connections yet.
            await new Promise((resolve) => setTimeout(resolve, 20));
            continue;
        }
        if (health.status === "ready") return;
        if (health.status === "error") {
            throw new Error(health.error ?? "The test daemon failed to start.");
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Timed out waiting for the test daemon.");
}
