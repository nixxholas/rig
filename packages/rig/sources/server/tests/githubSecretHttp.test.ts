import { rm } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ProtocolHttpClient } from "../../client/ProtocolHttpClient.js";
import { InMemorySessionStore } from "../../session/InMemorySessionStore.js";
import { createTestSocketDirectory } from "../../testing/createTestSocketDirectory.js";
import { createProtocolHttpServer } from "../createProtocolHttpServer.js";

describe("GitHub secret HTTP status", () => {
    it("reports model availability without serializing the token", async () => {
        const directory = await createTestSocketDirectory();
        const socketPath = join(directory, "server.sock");
        const store = new InMemorySessionStore();
        store.registerSpecialSecret({ kind: "github", token: "never-serialize-this" });
        const server = createProtocolHttpServer({ store, token: "daemon-token" });
        try {
            await new Promise<void>((resolve) => server.listen(socketPath, resolve));
            const client = new ProtocolHttpClient({
                socketPath,
                token: "daemon-token",
            });

            const response = await client.listSecrets();
            expect(response).toEqual({
                secrets: [
                    {
                        availableToModel: false,
                        description: "GitHub CLI credentials",
                        environmentVariables: ["GH_TOKEN"],
                        id: "github",
                        kind: "github",
                    },
                ],
            });
            expect(JSON.stringify(response)).not.toContain("never-serialize-this");
            await expect(
                client.updateSecret("github", { description: "User controlled" }),
            ).rejects.toMatchObject({ statusCode: 400 });
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await rm(directory, { force: true, recursive: true });
        }
    });
});
