import { describe, expect, it } from "vitest";

import type { SessionAssistantMessage, SessionMessage } from "@/core/SessionContext.js";
import { getCodexContextSuffix } from "@/vendors/codex/impl/getCodexContextSuffix.js";

describe("getCodexContextSuffix", () => {
    it("keeps provider context when tool argument JSON is reformatted", () => {
        const previous = [
            { role: "user", content: "Read it." },
            assistant('{"file_path": "/tmp/input", "line": 1}'),
        ] satisfies SessionMessage[];
        const current = [
            { role: "user", content: "Read it." },
            assistant('{"line":1,"file_path":"/tmp/input"}'),
            { role: "tool", callId: "call-1", content: "done" },
        ] satisfies SessionMessage[];

        expect(getCodexContextSuffix(previous, current)).toEqual([current[2]]);
    });

    it("rebuilds context when a tool argument value changes", () => {
        const previous = [assistant('{"line":1}')] satisfies SessionMessage[];
        const current = [assistant('{"line":2}')] satisfies SessionMessage[];

        expect(getCodexContextSuffix(previous, current)).toBeUndefined();
    });

    it("ignores caller-projected reasoning while retaining native provider state", () => {
        const previous = [
            {
                ...assistant('{"line":1}'),
                encryptedReasoning: "opaque",
                responseItems: ['{"type":"reasoning","encrypted_content":"opaque"}'],
            },
        ] satisfies SessionMessage[];
        const current = [
            {
                ...assistant('{"line":1}'),
                reasoning: [{ text: "Visible summary." }],
            },
            { role: "tool", callId: "call-1", content: "done" },
        ] satisfies SessionMessage[];

        expect(getCodexContextSuffix(previous, current)).toEqual([current[1]]);
    });

    it("keeps custom tool input byte-sensitive", () => {
        const customVendor = { provider: "codex", type: "custom_tool_call" };
        const previous = [
            {
                ...assistant('{"line": 1}'),
                toolCalls: [
                    {
                        callId: "call-1",
                        name: "Read",
                        arguments: '{"line": 1}',
                        vendor: customVendor,
                    },
                ],
            },
        ] satisfies SessionMessage[];
        const current = [
            {
                ...assistant('{"line":1}'),
                toolCalls: [
                    {
                        callId: "call-1",
                        name: "Read",
                        arguments: '{"line":1}',
                        vendor: customVendor,
                    },
                ],
            },
        ] satisfies SessionMessage[];

        expect(getCodexContextSuffix(previous, current)).toBeUndefined();
    });
});

function assistant(argumentsJson: string): SessionAssistantMessage {
    return {
        role: "assistant" as const,
        content: "",
        toolCalls: [
            {
                callId: "call-1",
                name: "Read",
                arguments: argumentsJson,
            },
        ],
    };
}