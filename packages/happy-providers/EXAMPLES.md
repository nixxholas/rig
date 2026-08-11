# Stateful session examples

These examples use the public `@slopus/happy-providers` API. Keep the division of labor from the
README in mind while reading them: the session owns the live provider state, and your application
owns and persists the transcript.

## Collect a turn for replay

To persist a conversation durably, rebuild the assistant message from the _committed_ events of a
run — retries can rewind tentative output, and `committedSessionEvents()` handles that for you.
Remember that tool execution happens outside this library; the collector only records the calls.

```ts
import {
    committedSessionEvents,
    type BaseSession,
    type SessionAssistantMessage,
    type SessionEvent,
    type SessionMessage,
    type SessionToolCall,
} from "@slopus/happy-providers";

async function runTurn(
    session: BaseSession,
    messages: readonly SessionMessage[],
): Promise<SessionAssistantMessage> {
    let content = "";
    let encryptedReasoning: string | undefined;
    const responseItems: string[] = [];
    const calls = new Map<string, SessionToolCall>();

    const streamed: SessionEvent[] = [];
    for await (const event of session.run({ context: { messages } })) streamed.push(event);

    for (const event of committedSessionEvents(streamed)) {
        switch (event.type) {
            case "text_delta":
                content += event.delta;
                break;
            case "encrypted_reasoning":
                encryptedReasoning = event.content;
                break;
            case "response_items":
                responseItems.push(...event.items);
                break;
            case "toolcall_start":
                if (event.server === true) break;
                calls.set(event.callId, {
                    callId: event.callId,
                    name: event.name,
                    ...(event.namespace === undefined ? {} : { namespace: event.namespace }),
                    arguments: "",
                    ...(event.vendor === undefined ? {} : { vendor: event.vendor }),
                });
                break;
            case "toolcall_delta": {
                const call = calls.get(event.callId);
                if (call !== undefined) {
                    calls.set(event.callId, {
                        ...call,
                        arguments: call.arguments + event.delta,
                    });
                }
                break;
            }
            case "toolcall_end": {
                const call = calls.get(event.callId);
                if (call !== undefined) {
                    calls.set(event.callId, {
                        ...call,
                        arguments: event.arguments,
                        ...(event.incomplete === undefined ? {} : { incomplete: event.incomplete }),
                    });
                }
                break;
            }
            case "done":
                if (event.state === "error") throw new Error(event.message);
                break;
        }
    }

    return {
        role: "assistant",
        content,
        ...(encryptedReasoning === undefined ? {} : { encryptedReasoning }),
        ...(responseItems.length === 0 ? {} : { responseItems }),
        ...(calls.size === 0 ? {} : { toolCalls: [...calls.values()] }),
    };
}
```

The collector ignores provider-owned calls (`server: true`) because those calls and results settle
inside the same provider response. Applications that present server-tool activity can collect the
corresponding result events separately, but must not send a client tool result for them.

## Continue after a client tool call

The library streams tool calls to you but never executes them. The rhythm is: declare tools when
creating the session, append the collected assistant message, execute each client-owned call
yourself, then append the tool-result messages before the next `run()`.

```ts
import { readFile } from "node:fs/promises";

import { Type } from "@sinclair/typebox";
import {
    CodexProvider,
    CodexSessionCredential,
    type SessionMessage,
    type SessionTool,
} from "@slopus/happy-providers";

const readTextFile = {
    name: "read_text_file",
    description: "Read a UTF-8 text file.",
    parameters: Type.Object({ path: Type.String() }),
} satisfies SessionTool;

const credential = await CodexSessionCredential.tryLoad();
if (credential === null) throw new Error("Sign in with Codex first.");

const provider = new CodexProvider({ credential, model: "gpt-5.6-sol" });
const session = await provider.session("tool-example", {
    instructions: "Use read_text_file when you need file contents.",
    tools: [readTextFile],
});

const messages: SessionMessage[] = [{ role: "user", content: "Summarize package.json." }];

try {
    const assistant = await runTurn(session, messages);
    messages.push(assistant);

    for (const call of assistant.toolCalls ?? []) {
        if (call.name !== "read_text_file" || call.incomplete === true) continue;
        const { path } = JSON.parse(call.arguments) as { path: string };
        try {
            messages.push({
                role: "tool",
                callId: call.callId,
                content: await readFile(path, "utf8"),
                ...(call.vendor === undefined ? {} : { vendor: call.vendor }),
            });
        } catch (error) {
            messages.push({
                role: "tool",
                callId: call.callId,
                content: error instanceof Error ? error.message : "The read failed.",
                isError: true,
                ...(call.vendor === undefined ? {} : { vendor: call.vendor }),
            });
        }
    }

    const finalAssistant = await runTurn(session, messages);
    messages.push(finalAssistant);
    console.log(finalAssistant.content);
} finally {
    await session.destroy();
}
```

Validate parsed tool arguments against the same TypeBox schema before executing them in a real
application. The cast above keeps the example focused on the session lifecycle.

## Compact and keep talking

Compaction updates the session's provider-native continuation state and hands you back the exact
replacement transcript to adopt.

```ts
const result = await session.compact({
    context: { messages },
    inputTokens: 120_000,
});

if (result.status === "completed") {
    messages.splice(0, messages.length, ...result.context.messages);
    messages.push({ role: "user", content: "Continue from the compacted context." });
} else if (result.status === "failed") {
    console.warn(result.message);
}
```

Do not append a completed compaction to the old transcript. Replace the selected context with the
returned context so opaque checkpoints and preserved messages stay in the provider's required
order.

## Other providers

The session lifecycle is the same for every provider; only construction and vendor options differ.

```ts
import {
    AnthropicProvider,
    BedrockBearerTokenCredential,
    ClaudeCodeCredential,
    GrokProvider,
    GrokSessionCredential,
    ResponsesProvider,
} from "@slopus/happy-providers";

const claudeCredential = await ClaudeCodeCredential.tryLoad();
if (claudeCredential !== null) {
    const claude = new AnthropicProvider({
        credential: claudeCredential,
        model: "claude-opus-4-6",
    });
    const session = await claude.session("claude-example", {
        instructions: "You are a concise coding assistant.",
    });
    await session.destroy();
}

const grokCredential = await GrokSessionCredential.tryLoad();
if (grokCredential !== null) {
    const grok = new GrokProvider({ credential: grokCredential, model: "grok-4.5" });
    const session = await grok.session("grok-example", {
        instructions: "You are a concise coding assistant.",
    });
    await session.destroy();
}

const bedrockCredential = await BedrockBearerTokenCredential.tryLoad();
if (bedrockCredential !== null) {
    const bedrock = new AnthropicProvider({
        credential: bedrockCredential,
        model: "anthropic/opus-4-8",
        region: "us-east-1",
        transport: "mantle",
    });
    const session = await bedrock.session("bedrock-example", {
        instructions: "You are a concise coding assistant.",
    });
    await session.destroy();
}

const responsesApiKey = process.env.RESPONSES_API_KEY;
if (responsesApiKey === undefined) throw new Error("Set RESPONSES_API_KEY first.");

const responses = new ResponsesProvider({
    apiKey: responsesApiKey,
    endpoint: "https://example.com/v1",
    model: "provider-model-id",
});
const responsesSession = await responses.session("responses-example", {
    instructions: "You are a concise coding assistant.",
});
await responsesSession.destroy();
```

Applications normally choose one configured provider at runtime rather than constructing all of
them together as this compact comparison does.
