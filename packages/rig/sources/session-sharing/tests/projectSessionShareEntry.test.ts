import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import type { AgentMessage, SystemMessage } from "../../agent/types.js";
import {
    projectSessionShareEntry,
    sessionShareAnyProjectionSchema,
    sessionShareProjectionSchema,
    sessionShareProjectionV1Schema,
} from "../projectSessionShareEntry.js";

const SECRET = "AKIAIOSFODNN7EXAMPLE";

describe("projectSessionShareEntry keeps tool payloads on the owner's machine", () => {
    it("describes a tool nobody wrote a shared summary for without replicating anything it saw", () => {
        // No `shared` on either block: an MCP tool, a plugin tool, a tool added
        // next week. The friend still learns the step happened.
        const message: AgentMessage = {
            blocks: [
                {
                    arguments: { path: ".env" },
                    id: "call-1",
                    name: "mystery_tool",
                    type: "tool_call",
                },
                {
                    display: `AWS_SECRET=${SECRET}`,
                    isError: false,
                    rendered: [{ text: `AWS_SECRET=${SECRET}`, type: "text" }],
                    toolCallId: "call-1",
                    toolName: "mystery_tool",
                    type: "tool_result",
                },
            ],
            id: "agent-1",
            role: "agent",
        };

        for (const toolOutput of ["summaries", "full"] as const) {
            const entry = projectSessionShareEntry({
                createdAt: 10,
                shareEventId: "event-1",
                shareId: "share-1",
                shareSequence: 1,
                source: { kind: "message", message, position: 4, runId: "run-1" },
                toolOutput,
            });

            expect(entry).toBeDefined();
            expect(entry!.canonicalJson).not.toContain(SECRET);
            expect(entry!.canonicalJson).not.toContain(".env");
            expect(entry!.canonicalJson).toContain("mystery_tool");
            expect(entry!.canonicalJson).toContain("The tool finished.");
        }
    });

    it("does not disclose a tool that never declared its output disclosable, even at full output", () => {
        const message: AgentMessage = {
            blocks: [
                {
                    arguments: { path: "id_rsa" },
                    id: "call-1",
                    name: "view_image",
                    shared: { summary: "Viewed the image diagram.png." },
                    type: "tool_call",
                },
                {
                    display: SECRET,
                    isError: false,
                    rendered: [{ text: SECRET, type: "text" }],
                    shared: { summary: "Loaded the image for viewing." },
                    toolCallId: "call-1",
                    toolName: "view_image",
                    type: "tool_result",
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
            source: { kind: "message", message, position: 1 },
            toolOutput: "full",
        });

        expect(entry!.canonicalJson).toContain("Loaded the image for viewing.");
        expect(entry!.canonicalJson).not.toContain(SECRET);
        expect(entry!.canonicalJson).not.toContain("id_rsa");
    });

    it("withholds a disclosable tool's output until the owner asks for full output", () => {
        const message: AgentMessage = {
            blocks: [
                {
                    arguments: { path: "config.ts" },
                    id: "call-1",
                    name: "Read",
                    shared: { disclosable: true, summary: "Read config.ts." },
                    type: "tool_call",
                },
                {
                    display: `export const key = "${SECRET}";`,
                    isError: false,
                    rendered: [{ text: `export const key = "${SECRET}";`, type: "text" }],
                    shared: { disclosable: true, summary: "Read 1 line of config.ts." },
                    toolCallId: "call-1",
                    toolName: "Read",
                    type: "tool_result",
                },
            ],
            id: "agent-1",
            role: "agent",
        };
        const options = {
            createdAt: 10,
            shareEventId: "event-1",
            shareId: "share-1",
            shareSequence: 1,
            source: { kind: "message" as const, message, position: 1 },
        };

        const summaries = projectSessionShareEntry({ ...options, toolOutput: "summaries" });
        expect(summaries!.canonicalJson).toContain("Read 1 line of config.ts.");
        expect(summaries!.canonicalJson).not.toContain(SECRET);
        expect(summaries!.canonicalJson).not.toContain('config.ts\\"');

        // A friend is told that something was held back, so they never have to
        // guess whether the tool simply printed nothing.
        expect(summaries!.canonicalJson).toContain('"withheld":true');

        const full = projectSessionShareEntry({ ...options, toolOutput: "full" });
        expect(full!.canonicalJson).toContain("Read 1 line of config.ts.");
        expect(full!.canonicalJson).toContain(SECRET);
        expect(full!.canonicalJson).toContain('"path":"config.ts"');
        expect(full!.canonicalJson).not.toContain("withheld");
    });

    it("discloses why a disclosable tool failed once the owner asks for full output", () => {
        const message: AgentMessage = {
            blocks: [
                {
                    display: `psql: could not connect using ${SECRET}`,
                    failure: {
                        kind: "execution_failed",
                        message: `psql: could not connect using ${SECRET}`,
                    },
                    isError: true,
                    rendered: [{ text: `psql: could not connect using ${SECRET}`, type: "text" }],
                    shared: { disclosable: true, summary: "The command exited with code 2." },
                    toolCallId: "call-1",
                    toolName: "Bash",
                    type: "tool_result",
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
            source: { kind: "message", message, position: 1 },
            toolOutput: "full",
        });

        expect(entry!.canonicalJson).toContain("The command exited with code 2.");
        expect(entry!.canonicalJson).toContain('"kind":"execution_failed"');
        expect(entry!.canonicalJson).toContain("failureMessage");
        expect(entry!.canonicalJson).toContain(SECRET);
    });

    it("keeps a failure legible while holding back the text the failure printed", () => {
        const message: AgentMessage = {
            blocks: [
                {
                    display: "",
                    failure: {
                        kind: "execution_failed",
                        message: `psql: connection to postgres://admin:${SECRET}@db failed`,
                    },
                    isError: true,
                    rendered: [],
                    shared: {
                        disclosable: true,
                        summary: "The command exited with code 1.",
                    },
                    toolCallId: "call-1",
                    toolName: "Bash",
                    type: "tool_result",
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
            source: { kind: "message", message, position: 1 },
            toolOutput: "summaries",
        });

        expect(entry!.canonicalJson).toContain("The command exited with code 1.");
        expect(entry!.canonicalJson).toContain('"isError":true');
        expect(entry!.canonicalJson).toContain('"kind":"execution_failed"');
        expect(entry!.canonicalJson).not.toContain(SECRET);
        expect(entry!.canonicalJson).not.toContain("psql");
    });

    it("names the outcome of an unsummarized failure in a sentence rather than a code", () => {
        const outcomes = [
            ["interrupted", "The tool was interrupted before it finished."],
            ["tool_unavailable", "The tool was not available."],
            ["invalid_arguments", "The tool was called with invalid arguments."],
            ["execution_failed", "The tool failed."],
        ] as const;

        for (const [kind, sentence] of outcomes) {
            const message: AgentMessage = {
                blocks: [
                    {
                        display: SECRET,
                        failure: { kind, message: SECRET },
                        isError: true,
                        rendered: [],
                        toolCallId: "call-1",
                        toolName: "unknown_tool",
                        type: "tool_result",
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
                source: { kind: "message", message, position: 1 },
                toolOutput: "full",
            });
            expect(entry!.canonicalJson).toContain(sentence);
            expect(entry!.canonicalJson).not.toContain(SECRET);
        }
    });

    it("replicates the conversation itself and the agent's visible reasoning", () => {
        const message: AgentMessage = {
            blocks: [
                { encrypted: "provider-secret", thinking: "Visible reasoning", type: "thinking" },
                { text: "Here is what I found.", type: "text" },
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
            toolOutput: "summaries",
        });

        expect(entry!.canonicalJson).toContain("Visible reasoning");
        expect(entry!.canonicalJson).toContain("Here is what I found.");
        expect(entry!.canonicalJson).not.toContain("provider-secret");
    });
});

describe("projectSessionShareEntry fails closed on everything it was not taught", () => {
    it("drops a message whose role it does not recognise", () => {
        expect(
            projectSessionShareEntry({
                createdAt: 1,
                shareEventId: "event-1",
                shareId: "share-1",
                shareSequence: 1,
                source: {
                    kind: "message",
                    message: {
                        blocks: [{ text: SECRET, type: "text" }],
                        id: "future-1",
                        role: "audit_log",
                    } as never,
                    position: 0,
                },
                toolOutput: "full",
            }),
        ).toBeUndefined();
    });

    it("drops an event whose type it does not recognise", () => {
        expect(
            projectSessionShareEntry({
                createdAt: 3,
                shareEventId: "event-metadata",
                shareId: "share-1",
                shareSequence: 3,
                source: {
                    event: {
                        createdAt: 3,
                        data: {
                            session: {
                                projectSecretIds: ["secret-attachment"],
                                sessionSecretIds: ["session-secret"],
                            },
                        },
                        id: "source-metadata",
                        sessionId: "session-1",
                        type: "session_updated",
                    } as never,
                    kind: "event",
                },
                toolOutput: "full",
            }),
        ).toBeUndefined();
    });

    it("refuses to read disclosure out of a block whose shared record is malformed", () => {
        // Every one of these is a `shared` that a corrupt row, an older Rig, or
        // a shape nobody anticipated could produce. None of them may be read as
        // permission to publish the payload.
        const malformed = [
            "full",
            ["disclosable"],
            42,
            null,
            { disclosable: "true", summary: 7 },
            { disclosable: 1 },
        ];

        for (const shared of malformed) {
            const message: AgentMessage = {
                blocks: [
                    {
                        display: SECRET,
                        isError: false,
                        rendered: [{ text: SECRET, type: "text" }],
                        shared,
                        toolCallId: "call-1",
                        toolName: "Read",
                        type: "tool_result",
                    } as never,
                ],
                id: "agent-1",
                role: "agent",
            };
            const entry = projectSessionShareEntry({
                createdAt: 10,
                shareEventId: "event-1",
                shareId: "share-1",
                shareSequence: 1,
                source: { kind: "message", message, position: 1 },
                toolOutput: "full",
            });
            expect(entry!.canonicalJson).not.toContain(SECRET);
            expect(entry!.canonicalJson).toContain('"withheld":true');
            expect(entry!.canonicalJson).toContain("The tool finished.");
        }
    });

    it("does not replicate the output of a command the user ran themselves", () => {
        // The blocks of this message are the command's own stdout and stderr.
        // The `shell_command_finished` event is what tells a friend it happened.
        expect(
            projectSessionShareEntry({
                createdAt: 1,
                shareEventId: "event-shell-message",
                shareId: "share-1",
                shareSequence: 1,
                source: {
                    kind: "message",
                    message: {
                        blocks: [
                            {
                                text: `<user_shell_command><result>Output:\nAWS_SECRET=${SECRET}</result></user_shell_command>`,
                                type: "text",
                            },
                        ],
                        id: "shell-1",
                        role: "user",
                        shellCommandId: "command-1",
                    },
                    position: 0,
                },
                toolOutput: "full",
            }),
        ).toBeUndefined();
    });

    it("keeps a permission decision without the reviewer's own words about it", () => {
        const entry = projectSessionShareEntry({
            createdAt: 11,
            shareEventId: "event-permission",
            shareId: "share-1",
            shareSequence: 2,
            source: {
                event: {
                    createdAt: 11,
                    data: {
                        event: {
                            // Built out of the tool's raw arguments by the tool's
                            // own describeAutoPermissionAction.
                            action: `sending "${SECRET}" to shell session 1`,
                            decision: "deny",
                            reason: `The command would upload ${SECRET} to a third party.`,
                            risk: "high",
                            toolCallId: "call-2",
                            type: "permission_review",
                            userAuthorization: "unknown",
                        },
                        runId: "run-1",
                    },
                    id: "source-permission",
                    sessionId: "session-1",
                    type: "agent_event",
                } as never,
                kind: "event",
            },
            toolOutput: "full",
        });

        // The friend learns a review happened, what it decided, and how risky it
        // was. What was being attempted is the tool call's own summary beside it.
        expect(entry!.canonicalJson).toContain("permission_review");
        expect(entry!.canonicalJson).toContain('"decision":"deny"');
        expect(entry!.canonicalJson).toContain('"risk":"high"');
        expect(entry!.canonicalJson).not.toContain(SECRET);
    });

    it("keeps a provider failure legible without republishing whatever it echoed", () => {
        const entry = projectSessionShareEntry({
            createdAt: 12,
            shareEventId: "event-run-error",
            shareId: "share-1",
            shareSequence: 3,
            source: {
                event: {
                    createdAt: 12,
                    data: {
                        errorMessage: `The request was rejected. Request body: ${"x".repeat(2000)}${SECRET}`,
                        runId: "run-1",
                    },
                    id: "source-run-error",
                    sessionId: "session-1",
                    type: "run_error",
                } as never,
                kind: "event",
            },
            toolOutput: "full",
        });

        expect(entry!.canonicalJson).toContain("The request was rejected.");
        expect(entry!.canonicalJson).toContain("The rest was too long to share.");
        expect(entry!.canonicalJson).not.toContain(SECRET);
    });

    it("drops durable model context that is not transcript history", () => {
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
                toolOutput: "full",
            }),
        ).toBeUndefined();
    });

    it("reports how a shell command the user ran ended without repeating what it printed", () => {
        const entry = projectSessionShareEntry({
            createdAt: 4,
            shareEventId: "event-shell",
            shareId: "share-1",
            shareSequence: 4,
            source: {
                event: {
                    createdAt: 4,
                    data: {
                        command: "printenv",
                        commandId: "command-1",
                        exitCode: 1,
                        output: `AWS_SECRET=${SECRET}`,
                        timedOut: false,
                    },
                    id: "source-shell",
                    sessionId: "session-1",
                    type: "shell_command_finished",
                } as never,
                kind: "event",
            },
            toolOutput: "full",
        });

        expect(entry!.canonicalJson).toContain('"command":"printenv"');
        expect(entry!.canonicalJson).toContain('"exitCode":1');
        expect(entry!.canonicalJson).not.toContain(SECRET);
    });
});

describe("projectSessionShareEntry produces a stable, versioned entry", () => {
    it("hashes the same bytes for the same message and stamps version 2", () => {
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
            toolOutput: "summaries" as const,
        };
        const first = projectSessionShareEntry(options);
        const second = projectSessionShareEntry(options);

        expect(first).toEqual(second);
        expect(first!.contentHash).toBe(second!.contentHash);
        expect(first!.canonicalJson).toBe(
            '{"kind":"message","payload":{"blocks":[{"text":"Everything stays visible.","type":"text"}],"id":"visible-1","role":"system"},"position":1,"version":2}',
        );
    });

    it("only ever emits the shape version 2 declares, and leaves version 1 readable", () => {
        const sources = [
            {
                kind: "message" as const,
                message: {
                    blocks: [
                        {
                            arguments: { path: ".env" },
                            id: "call-1",
                            name: "Read",
                            shared: { disclosable: true as const, summary: "Read .env." },
                            type: "tool_call" as const,
                        },
                    ],
                    id: "agent-1",
                    role: "agent" as const,
                },
                position: 3,
                runId: "run-1",
            },
            {
                event: {
                    createdAt: 1,
                    data: { command: "ls", commandId: "command-1", exitCode: 0 },
                    id: "source-shell",
                    sessionId: "session-1",
                    type: "shell_command_finished",
                } as never,
                kind: "event" as const,
            },
        ];

        for (const source of sources) {
            for (const toolOutput of ["summaries", "full"] as const) {
                const entry = projectSessionShareEntry({
                    createdAt: 1,
                    shareEventId: "event-1",
                    shareId: "share-1",
                    shareSequence: 1,
                    source,
                    toolOutput,
                });
                const projection: unknown = JSON.parse(entry!.canonicalJson);
                expect(Value.Check(sessionShareProjectionSchema, projection)).toBe(true);
                expect(Value.Check(sessionShareAnyProjectionSchema, projection)).toBe(true);
                expect(Value.Check(sessionShareProjectionV1Schema, projection)).toBe(false);
            }
        }

        // A replica holding an entry delivered before this change still matches
        // something, which is the whole reason version 1 is still declared.
        const delivered = { kind: "message", payload: {}, position: 0, version: 1 };
        expect(Value.Check(sessionShareAnyProjectionSchema, delivered)).toBe(true);
        expect(Value.Check(sessionShareProjectionSchema, delivered)).toBe(false);
    });

    it("hashes a summarised tool call the same way every time", () => {
        const options = {
            createdAt: 2,
            shareEventId: "event-tool",
            shareId: "share-1",
            shareSequence: 3,
            source: {
                kind: "message" as const,
                message: {
                    blocks: [
                        {
                            arguments: { pattern: "TODO" },
                            id: "call-1",
                            name: "Grep",
                            shared: {
                                disclosable: true as const,
                                summary: 'Searched for "TODO".',
                            },
                            type: "tool_call" as const,
                        },
                    ],
                    id: "agent-1",
                    role: "agent" as const,
                },
                position: 2,
            },
            toolOutput: "summaries" as const,
        };

        const first = projectSessionShareEntry(options);
        const second = projectSessionShareEntry(options);

        expect(first!.contentHash).toBe(second!.contentHash);
        expect(first!.canonicalJson).toBe(
            '{"kind":"message","payload":{"blocks":[{"id":"call-1","name":"Grep","summary":"Searched for \\"TODO\\".","type":"tool_call"}],"id":"agent-1","role":"agent"},"position":2,"version":2}',
        );
        // The same call at full output is a different entry, so a friend can
        // never mistake one for the other by hash.
        const full = projectSessionShareEntry({ ...options, toolOutput: "full" });
        expect(full!.contentHash).not.toBe(first!.contentHash);
    });
});
