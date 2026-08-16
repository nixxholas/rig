import type { AgentBaseToolOutcome, AgentMessageMetadata } from "@slopus/happy-agent-base";
import type { SessionUserMessage } from "@slopus/happy-providers";
import { describe, expect, it } from "vitest";

import {
    assistantTextEvidence,
    assistantToolCallEvidence,
    errorEvidence,
    outcomeToolName,
    toolResultEvidence,
    userMessageEvidence,
} from "../../sources/auto/impl/evidenceEntries.js";

function userText(text: string): SessionUserMessage {
    return { role: "user", content: [{ type: "text", text }] };
}

function metadata(fields: Record<string, unknown>): AgentMessageMetadata {
    return fields as unknown as AgentMessageMetadata;
}

describe("userMessageEvidence", () => {
    it("classifies an ordinary human message as trusted message evidence", () => {
        const entry = userMessageEvidence(userText("please edit the file"), undefined);
        expect(entry).toMatchObject({
            category: "message",
            trustedUserEvidence: true,
            entry: { role: "user", blocks: [{ type: "text", text: "please edit the file" }] },
        });
        expect(entry?.entry.provenance).toBeUndefined();
    });

    it("marks a collaboration message untrusted with agent provenance", () => {
        const entry = userMessageEvidence(
            userText("from another agent"),
            metadata({ collaboration: { origin: "peer" } }),
        );
        expect(entry?.trustedUserEvidence).toBe(false);
        expect(entry?.entry.provenance).toBe("agent");
        expect(entry?.category).toBe("message");
    });

    it("classifies a direct user shell command as untrusted tool evidence", () => {
        const entry = userMessageEvidence(
            userText("<user_shell_command>ls -la</user_shell_command>"),
            undefined,
        );
        expect(entry?.category).toBe("tool");
        expect(entry?.trustedUserEvidence).toBe(false);
    });

    it("drops a message hidden from the user", () => {
        expect(userMessageEvidence(userText("secret"), metadata({ hideFromUser: true }))).toBeUndefined();
    });
});

describe("assistant evidence", () => {
    it("records assistant text as untrusted agent evidence", () => {
        const entry = assistantTextEvidence("I will read the file.");
        expect(entry).toMatchObject({
            category: "message",
            trustedUserEvidence: false,
            entry: { role: "agent", blocks: [{ type: "text", text: "I will read the file." }] },
        });
    });

    it("records a tool call with parsed arguments as untrusted agent evidence", () => {
        const entry = assistantToolCallEvidence("read_file", '{"path":"a.txt"}');
        expect(entry.trustedUserEvidence).toBe(false);
        expect(entry.entry.blocks[0]).toMatchObject({
            type: "tool_call",
            name: "read_file",
            arguments: { path: "a.txt" },
        });
    });

    it("keeps unparseable tool-call arguments as the raw string", () => {
        const entry = assistantToolCallEvidence("run", "not json");
        expect(entry.entry.blocks[0]).toMatchObject({ arguments: "not json" });
    });
});

describe("toolResultEvidence", () => {
    it("classifies an ordinary result as untrusted tool evidence", () => {
        const entry = toolResultEvidence({
            toolName: "read_file",
            content: [{ type: "text", text: "file body" }],
            isError: false,
        });
        expect(entry.category).toBe("tool");
        expect(entry.trustedUserEvidence).toBe(false);
        expect(entry.entry.blocks[0]).toMatchObject({
            type: "tool_result",
            toolName: "read_file",
            isError: false,
        });
    });

    it("classifies a result carrying a human answer as trusted message evidence", () => {
        const entry = toolResultEvidence({
            toolName: "ask_user",
            content: [{ type: "text", text: "answered" }],
            isError: false,
            trustedUserAnswer: [{ type: "text", text: "yes, go ahead" }],
        });
        expect(entry.category).toBe("message");
        expect(entry.trustedUserEvidence).toBe(true);
        expect(entry.entry.blocks[0]).toMatchObject({
            trustedUserEvidence: [{ type: "text", text: "yes, go ahead" }],
        });
    });
});

describe("errorEvidence", () => {
    it("marks a retried provider error with the retried outcome", () => {
        const entry = errorEvidence("timeout, retrying", true);
        expect(entry.entry).toMatchObject({ role: "error", outcome: "retried" });
        expect(entry.trustedUserEvidence).toBe(false);
    });

    it("records a terminal error without an outcome", () => {
        const entry = errorEvidence("run failed", false);
        expect(entry.entry.role).toBe("error");
        expect(entry.entry.outcome).toBeUndefined();
    });
});

describe("outcomeToolName", () => {
    it("returns a bare name when there is no namespace", () => {
        expect(outcomeToolName({ tool: { name: "read_file" } } as AgentBaseToolOutcome)).toBe(
            "read_file",
        );
    });

    it("namespaces the name as the model saw it", () => {
        expect(
            outcomeToolName({
                tool: { name: "search", namespace: "mcp" },
            } as AgentBaseToolOutcome),
        ).toBe("mcp/search");
    });
});
