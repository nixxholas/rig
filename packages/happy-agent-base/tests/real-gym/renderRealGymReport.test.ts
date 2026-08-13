import { describe, expect, it } from "vitest";

import type { RealGymTrace } from "./RealGymTrace.js";
import { renderRealGymReport } from "./renderRealGymReport.js";

const trace: RealGymTrace = {
    scenario: "Tool call through codex",
    vendor: "codex",
    model: "openai/gpt-5.6-sol",
    credential: "codex-session",
    agentId: "real-gym-codex-1",
    environment: {
        osVersion: "25.5.0",
        platform: "darwin",
        workingDirectory: "/work",
        shell: "/bin/zsh",
    },
    features: ["system", "models", "subagents", "autocompaction", "gym"],
    models: ["openai/gpt-5.6-sol"],
    sessions: [
        {
            instructions: "You are Rig.\n\n# Environment\n- Platform: <darwin>",
            tools: [
                {
                    name: "record_answer",
                    description: "Record your final answer.",
                    parameters: { type: "object" },
                },
            ],
        },
    ],
    inferences: [
        {
            model: "openai/gpt-5.6-sol",
            effort: "low",
            serviceTier: undefined,
            messages: [{ role: "user", content: [{ type: "text", text: "Capital of France?" }] }],
            events: [
                { atMs: 12, event: { type: "reasoning_start" } },
                { atMs: 13, event: { type: "reasoning_delta", delta: "thinking" } },
                {
                    atMs: 14,
                    event: { type: "toolcall_start", callId: "c1", name: "record_answer" },
                },
                {
                    atMs: 18,
                    event: { type: "toolcall_end", callId: "c1", arguments: '{"answer":"Paris"}' },
                },
                {
                    atMs: 21,
                    event: { type: "done", state: "tool_call", tokens: { input: 120, output: 3 } },
                },
            ],
            startedAtMs: 1_000,
            finishedAtMs: 1_500,
            tokens: { input: 120, output: 3 },
            doneState: "tool_call",
            failure: undefined,
        },
    ],
    transcript: [{ role: "user", content: [{ type: "text", text: "Capital of France?" }] }],
    startedAtMs: 1_000,
    finishedAtMs: 2_000,
    outcome: "passed",
    failure: undefined,
    prompt: "Capital of France?",
    response: "Paris",
};

describe("renderRealGymReport", () => {
    it("reports the agent, its features, and everything one scenario did", () => {
        const html = renderRealGymReport([trace]);

        expect(html).toContain("Tool call through codex");
        expect(html).toContain("openai/gpt-5.6-sol");
        expect(html).toContain("codex-session");
        expect(html).toContain("1.00 s");
        expect(html).toContain("120 in / 3 out");
        // The agent's own shape: features, offered models, and the environment it works in.
        expect(html).toContain("autocompaction");
        expect(html).toContain("/work");
        expect(html).toContain("darwin 25.5.0");
        // What the features assembled, and what the model did with it.
        expect(html).toContain("record_answer");
        expect(html).toContain("Record your final answer.");
        expect(html).toContain("{&quot;answer&quot;:&quot;Paris&quot;}");
        expect(html).toContain("thinking");
        // Every streamed event is listed with when it arrived.
        expect(html).toContain("toolcall_end");
        expect(html).toContain("18 ms");
        expect(html).toContain("Durable transcript");
        // Prompt text is escaped rather than injected into the page.
        expect(html).toContain("- Platform: &lt;darwin&gt;");
        expect(html).not.toContain("<darwin>");
    });

    it("says plainly when nothing ran", () => {
        expect(renderRealGymReport([])).toContain("No scenario ran");
    });
});
