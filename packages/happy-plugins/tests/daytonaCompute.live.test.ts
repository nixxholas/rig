import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createDaytonaComputeProvider } from "../examples/daytona/daytonaCompute.ts";

const apiKey = process.env.DAYTONA_TEST_API_KEY;

describe.skipIf(apiKey === undefined)("Daytona compute live (on demand)", () => {
    it("runs a real sandbox lifecycle and always cleans it up", async () => {
        const source = await mkdtemp(join(process.cwd(), "daytona-live-"));
        await writeFile(join(source, "message.txt"), "hello");
        const provider = createDaytonaComputeProvider({ apiKey: apiKey! });
        const context = { signal: AbortSignal.timeout(150_000) };
        let instanceId: string | undefined;
        try {
            instanceId = await provider.handlers.start(
                { workspaceSource: { path: source, type: "local_directory" } },
                context,
            );
            await provider.handlers.write(
                {
                    bytes: Buffer.from("live"),
                    instanceId,
                    path: "written.txt",
                },
                context,
            );
            await expect(
                provider.handlers.read({ instanceId, path: "written.txt" }, context),
            ).resolves.toEqual(Buffer.from("live"));
            await expect(
                provider.handlers.exec(
                    {
                        command: "cat message.txt; printf warning >&2",
                        instanceId,
                        timeoutMs: 30_000,
                    },
                    context,
                ),
            ).resolves.toMatchObject({
                exitCode: 0,
                stderr: "warning",
                stdout: "hello",
                timedOut: false,
            });
        } finally {
            if (instanceId !== undefined) {
                await Promise.resolve(provider.handlers.stop({ instanceId }, context)).catch(
                    () => undefined,
                );
            }
            await provider.close();
            await rm(source, { force: true, recursive: true });
        }
    }, 180_000);
});
