import { describe, expect, it } from "vitest";

import type { AgentMessage, SystemMessage } from "../../agent/types.js";
import { projectSessionShareEntry } from "../projectSessionShareEntry.js";

describe("projectSessionShareEntry", () => {
    it("replicates full visible thinking, tool calls, outputs, failures, and permission rows", () => {
        const message: AgentMessage = {
            blocks: [
                { encrypted: "provider-secret", thinking: "Visible reasoning", type: "thinking" },
                {
                    arguments: { path: "notes.txt" },
                    id: "call-1",
                    name: "read_file",
                    type: "tool_call",
                    vendor: { opaque: "provider-only" },
                },
                {
                    display: "Read notes.txt",
                    isError: false,
                    rendered: [{ text: "unredacted tool output", type: "text" }],
                    toolCallId: "call-1",
                    toolName: "read_file",
                    type: "tool_result",
                    vendor: { opaque: "provider-only" },
                },
            ],
            id: "agent-1",
            role: "agent",
        };

        const entry = projectSessionShareEntry({
            createdAt: 10,
            shareEventId: "event-1",
            shareId: "share-1",
            shareSequence: 1,
            source: { kind: "message", message, position: 4, runId: "run-1" },
        });

        expect(entry).toBeDefined();
        expect(entry!.canonicalJson).toContain("Visible reasoning");
        expect(entry!.canonicalJson).toContain("unredacted tool output");
        expect(entry!.canonicalJson).toContain("read_file");
        expect(entry!.canonicalJson).not.toContain("provider-secret");
        expect(entry!.canonicalJson).not.toContain("provider-only");

        const permission = projectSessionShareEntry({
            createdAt: 11,
            shareEventId: "event-2",
            shareId: "share-1",
            shareSequence: 2,
            source: {
                event: {
                    createdAt: 11,
                    data: {
                        event: {
                            action: "write outside the workspace",
                            decision: "deny",
                            reason: "Not authorized",
                            risk: "high",
                            toolCallId: "call-2",
                            type: "permission_review",
                            userAuthorization: "unknown",
                        },
                        runId: "run-1",
                    },
                    id: "source-event",
                    sessionId: "session-1",
                    type: "agent_event",
                },
                kind: "event",
            },
        });
        expect(permission!.canonicalJson).toContain("permission_review");
        expect(permission!.canonicalJson).toContain("Not authorized");
    });

    it("is canonical and excludes only internal or provider-only fields", () => {
        const internal: SystemMessage = {
            blocks: [{ text: "provider-only context", type: "text" }],
            id: "internal-1",
            internal: true,
            role: "system",
        };
        expect(
            projectSessionShareEntry({
                createdAt: 1,
                shareEventId: "event-internal",
                shareId: "share-1",
                shareSequence: 1,
                source: { kind: "message", message: internal, position: 0 },
            }),
        ).toBeUndefined();

        const options = {
            createdAt: 2,
            shareEventId: "event-visible",
            shareId: "share-1",
            shareSequence: 2,
            source: {
                kind: "message" as const,
                message: {
                    blocks: [{ text: "Everything stays visible.", type: "text" as const }],
                    id: "visible-1",
                    role: "system" as const,
                },
                position: 1,
            },
        };
        const first = projectSessionShareEntry(options);
        const second = projectSessionShareEntry(options);
        expect(first).toEqual(second);
        expect(first!.canonicalJson).toBe(
            '{"kind":"message","payload":{"blocks":[{"text":"Everything stays visible.","type":"text"}],"id":"visible-1","role":"system"},"position":1,"version":1}',
        );
    });
});
