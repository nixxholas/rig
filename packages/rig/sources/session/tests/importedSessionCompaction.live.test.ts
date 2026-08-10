import { createTestRootContext } from "../../testing/createTestRootContext.js";
import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createCodingAssistantAgent } from "../../runtime/createCodingAssistantAgent.js";
import { PersistentSessionStore } from "../PersistentSessionStore.js";

const LIVE = process.env.RIG_LIVE_TEST === "1";
const databasePath = process.env.RIG_IMPORTED_STATE_DB;
const sessionId = process.env.RIG_IMPORTED_SESSION_ID;
const hasBedrockCredential = (process.env.AWS_BEARER_TOKEN_BEDROCK?.trim().length ?? 0) > 0;
const hasFixture =
    databasePath !== undefined &&
    sessionId !== undefined &&
    existsSync(databasePath) &&
    hasBedrockCredential;
const ctx = createTestRootContext();

describe.skipIf(!LIVE || !hasFixture)("imported session compaction", () => {
    it("compacts the restored production session", async () => {
        const store = await PersistentSessionStore.open(ctx, {
            createRuntime: (options) =>
                createCodingAssistantAgent({
                    ...options,
                    providers: {
                        bedrock: {
                            enabled: true,
                            region: "us-east-2",
                            type: "bedrock",
                        },
                    },
                }),
            databasePath: databasePath!,
        });

        try {
            const session = await store.get(ctx, sessionId!);
            expect(session).toBeDefined();

            const result = await session!.compact(ctx);

            expect(result.compacted).toBe(true);
            expect(result.estimatedTokensAfter).toBeLessThan(result.estimatedTokensBefore);
        } finally {
            await store.close(ctx);
        }
    }, 300_000);
});
