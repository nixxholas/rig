import { describe, expect, it } from "vitest";

import { Agent } from "./Agent.js";
import { AGENTS_MD_REPLACEMENT_NOTICE } from "./agentsMdNotices.js";
import { createJustBashToolHarness } from "../tools/testing/createJustBashToolHarness.js";
import { isInternalMessage } from "./isInternalMessage.js";
import {
    defineModel,
    defineProvider,
    type AssistantMessage,
    type Context,
    type InferenceStream,
    type Usage,
} from "@slopus/rig-execution";

const model = defineModel({
    id: "openai/gpt-test",
    name: "GPT Test",
    thinkingLevels: ["off"],
    defaultThinkingLevel: "off",
});

function zeroUsage(): Usage {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
}

function streamFor(message: AssistantMessage): InferenceStream {
    return {
        [Symbol.asyncIterator]: async function* () {
            yield { type: "text", text: "ok" } as never;
        },
        result: async () => message,
    } as unknown as InferenceStream;
}

/** Captures the exact context handed to the provider on every turn. */
function createRecordingProvider(): {
    provider: ReturnType<typeof defineProvider>;
    contexts: Context[];
    systemPrompts: (string | undefined)[];
} {
    const contexts: Context[] = [];
    const systemPrompts: (string | undefined)[] = [];
    const provider = defineProvider({
        id: "codex",
        models: [model],
        stream(_model, context) {
            contexts.push(context);
            systemPrompts.push(context.systemPrompt);
            return streamFor({
                role: "assistant",
                content: [{ type: "text", text: "done" }],
                api: "test",
                provider: "codex",
                model: model.id,
                usage: zeroUsage(),
                stopReason: "stop",
                timestamp: contexts.length,
            });
        },
    });

    return { provider, contexts, systemPrompts };
}

async function createWorkspace(
    provider: ReturnType<typeof defineProvider>,
    instructions?: string,
): Promise<{ agent: Agent; writeInstructions: (text: string) => Promise<void> }> {
    const harness = createJustBashToolHarness({ cwd: "/workspace" });
    if (instructions !== undefined) {
        await harness.writeFile("/workspace/AGENTS.md", instructions);
    }
    const agent = new Agent({
        context: harness.context,
        modelId: model.id,
        provider,
        tools: [],
    });

    return {
        agent,
        writeInstructions: (text) => harness.writeFile("/workspace/AGENTS.md", text),
    };
}

function textOfFirstUserContent(context: Context): string {
    const first = context.messages[0];
    if (first?.role !== "user") return "";
    if (typeof first.content === "string") return first.content;
    return first.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

describe("project instructions in the conversation", () => {
    it("hands AGENTS.md to the model ahead of the first user message", async () => {
        const { provider, contexts, systemPrompts } = createRecordingProvider();
        const { agent } = await createWorkspace(provider, "Always run the linter.\n");

        await agent.send("Fix the bug.");

        expect(contexts).toHaveLength(1);
        const leading = textOfFirstUserContent(contexts[0]!);
        expect(leading).toContain("Always run the linter.");
        expect(leading).toContain("# AGENTS.md instructions for");
        expect(contexts[0]!.messages).toHaveLength(2);
        expect(systemPrompts[0]).not.toContain("Always run the linter.");
    });

    it("keeps the recorded instructions out of the visible transcript", async () => {
        const { provider } = createRecordingProvider();
        const { agent } = await createWorkspace(provider, "Always run the linter.\n");

        await agent.send("Fix the bug.");

        expect(agent.messages.some((message) => isInternalMessage(message))).toBe(false);
        const snapshot = agent.snapshot();
        const recorded = (snapshot.contextMessages ?? []).filter((message) =>
            isInternalMessage(message),
        );
        expect(recorded).toHaveLength(1);
    });

    it("repeats byte-identical instructions while the file is unchanged", async () => {
        const { provider, contexts } = createRecordingProvider();
        const { agent } = await createWorkspace(provider, "Always run the linter.\n");

        await agent.send("Fix the bug.");
        await agent.send("Keep going.");

        expect(contexts).toHaveLength(2);
        expect(textOfFirstUserContent(contexts[1]!)).toBe(textOfFirstUserContent(contexts[0]!));
        const recorded = (agent.snapshot().contextMessages ?? []).filter((message) =>
            isInternalMessage(message),
        );
        expect(recorded).toHaveLength(1);
    });

    it("supersedes edited instructions without losing the originals", async () => {
        const { provider, contexts } = createRecordingProvider();
        const { agent, writeInstructions } = await createWorkspace(
            provider,
            "Always run the linter.\n",
        );

        await agent.send("Fix the bug.");
        await writeInstructions("Always run the type checker.\n");
        await agent.send("Keep going.");

        const recorded = (agent.snapshot().contextMessages ?? []).filter((message) =>
            isInternalMessage(message),
        );
        expect(recorded).toHaveLength(2);
        expect(textOfFirstUserContent(contexts[1]!)).toContain("Always run the linter.");

        const superseding = recorded[1]!;
        const text = superseding.blocks
            .map((block) => (block.type === "text" ? block.text : ""))
            .join("");
        expect(text).toContain(AGENTS_MD_REPLACEMENT_NOTICE);
        expect(text).toContain("Always run the type checker.");
    });

    it("adds nothing to a project without instructions", async () => {
        const { provider, contexts } = createRecordingProvider();
        const { agent } = await createWorkspace(provider);

        await agent.send("Fix the bug.");

        expect(contexts[0]!.messages).toHaveLength(1);
        expect(agent.snapshot().contextMessages).toBeUndefined();
    });
});
