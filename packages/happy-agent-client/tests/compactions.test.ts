import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { compactionListResponseSchema, compactionSchema } from "../sources/protocol/compactions.js";

const version = "01991f3a-6353-7000-8000-a16273041536";

describe("compaction protocol", () => {
    it("describes a running manual compaction without inferring from agent status", () => {
        expect(
            Value.Check(compactionSchema, {
                id: "compaction1",
                agentId: "agent1",
                runId: null,
                trigger: "manual",
                status: "running",
                tokensBefore: 201_000,
                tokensAfter: null,
                failureReason: null,
                startedAt: 1_755_400_000_000,
                completedAt: null,
                updatedAt: 1_755_400_000_000,
                version,
            }),
        ).toBe(true);
    });

    it("associates a completed automatic compaction with its run", () => {
        expect(
            Value.Check(compactionSchema, {
                id: "compaction2",
                agentId: "agent1",
                runId: "run1",
                trigger: "automatic",
                status: "completed",
                tokensBefore: 210_000,
                tokensAfter: 45_000,
                failureReason: null,
                startedAt: 1_755_400_000_000,
                completedAt: 1_755_400_001_000,
                updatedAt: 1_755_400_002_000,
                version,
            }),
        ).toBe(true);
    });

    it("requires a terminal timestamp and meaningful reason for failure", () => {
        const failed = {
            id: "compaction3",
            agentId: "agent1",
            runId: null,
            trigger: "manual",
            status: "failed",
            tokensBefore: null,
            tokensAfter: null,
            failureReason: "The provider could not compact the context.",
            startedAt: 1_755_400_000_000,
            completedAt: 1_755_400_001_000,
            updatedAt: 1_755_400_001_000,
            version,
        };
        expect(Value.Check(compactionSchema, failed)).toBe(true);
        expect(
            Value.Check(compactionSchema, {
                ...failed,
                failureReason: null,
            }),
        ).toBe(false);
    });

    it("validates a reconnect page containing running and settled attempts", () => {
        const response = {
            compactions: [
                {
                    id: "compaction4",
                    agentId: "agent1",
                    runId: null,
                    trigger: "manual",
                    status: "running",
                    tokensBefore: 180_000,
                    tokensAfter: null,
                    failureReason: null,
                    startedAt: 1_755_400_003_000,
                    completedAt: null,
                    updatedAt: 1_755_400_003_000,
                    version,
                },
                {
                    id: "compaction3",
                    agentId: "agent1",
                    runId: null,
                    trigger: "manual",
                    status: "failed",
                    tokensBefore: null,
                    tokensAfter: null,
                    failureReason: "The daemon restarted during compaction.",
                    startedAt: 1_755_400_000_000,
                    completedAt: 1_755_400_001_000,
                    updatedAt: 1_755_400_001_000,
                    version,
                },
            ],
            hasMore: false,
        };

        expect(Value.Check(compactionListResponseSchema, response)).toBe(true);
    });
});
