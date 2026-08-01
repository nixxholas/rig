import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { ProtocolHttpClient } from "../../client/ProtocolHttpClient.js";
import { GLOBAL_AGENTS_MD_MAX_BYTES } from "../../config/globalAgentsMdMaxBytes.js";
import { createProtocolHttpServer } from "../createProtocolHttpServer.js";

describe("global instructions over the local protocol", () => {
    it("reports no instructions until the user writes some", async () => {
        const { client, close } = await startServer();
        try {
            await expect(client.getGlobalInstructions()).resolves.toEqual({ instructions: "" });
        } finally {
            await close();
        }
    });

    it("stores the instructions as AGENTS.md and reads them back", async () => {
        const { client, close, instructionsPath } = await startServer();
        try {
            await expect(
                client.updateGlobalInstructions({ instructions: "Answer in English.\n" }),
            ).resolves.toEqual({ instructions: "Answer in English.\n" });
            await expect(readFile(instructionsPath, "utf8")).resolves.toBe("Answer in English.\n");
            expect((await stat(instructionsPath)).mode & 0o777).toBe(0o600);
            await expect(client.getGlobalInstructions()).resolves.toEqual({
                instructions: "Answer in English.\n",
            });
        } finally {
            await close();
        }
    });

    it("reads instructions the user edited on disk", async () => {
        const { client, close, instructionsPath } = await startServer();
        try {
            await writeFile(instructionsPath, "Answer in French.\n", "utf8");
            await expect(client.getGlobalInstructions()).resolves.toEqual({
                instructions: "Answer in French.\n",
            });
        } finally {
            await close();
        }
    });

    it("clears the instructions when the user submits blank text", async () => {
        const { client, close, instructionsPath } = await startServer();
        try {
            await client.updateGlobalInstructions({ instructions: "Answer in English.\n" });
            await expect(
                client.updateGlobalInstructions({ instructions: "   \n" }),
            ).resolves.toEqual({ instructions: "" });
            await expect(readFile(instructionsPath, "utf8")).resolves.toBe("");
            expect((await stat(instructionsPath)).mode & 0o777).toBe(0o600);
        } finally {
            await close();
        }
    });

    it("refuses instructions larger than the allowed limit", async () => {
        const { client, close } = await startServer();
        try {
            await expect(
                client.updateGlobalInstructions({
                    instructions: "x".repeat(GLOBAL_AGENTS_MD_MAX_BYTES + 1),
                }),
            ).rejects.toThrow("Global instructions must be smaller than 32 KB.");
        } finally {
            await close();
        }
    });

    it("refuses instructions that are not text", async () => {
        const { client, close } = await startServer();
        try {
            await expect(
                client.updateGlobalInstructions({ instructions: 7 as unknown as string }),
            ).rejects.toThrow("Global instructions must be text.");
        } finally {
            await close();
        }
    });
});

async function startServer(): Promise<{
    client: ProtocolHttpClient;
    close: () => Promise<void>;
    instructionsPath: string;
}> {
    const directory = await mkdtemp(join(tmpdir(), "rig-instructions-test-"));
    const socketPath = join(directory, "server.sock");
    const instructionsPath = join(directory, "AGENTS.md");
    const server = createProtocolHttpServer({
        globalInstructionsPath: instructionsPath,
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
        instructionsPath,
        async close() {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await rm(directory, { recursive: true, force: true });
        },
    };
}
