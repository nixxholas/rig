import type { SessionEvent } from "@slopus/happy-providers";
import { Type } from "@sinclair/typebox";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { Agent, defineAgentTool, type AgentFeature } from "../sources/index.js";
import { providersOf, system, textTurn, user } from "./gym/fixtures.js";
import { InMemoryPersistence } from "./gym/InMemoryPersistence.js";
import { ScriptedProvider } from "./gym/ScriptedProvider.js";

const ctx = createRootContext().named("happy-agent-test");

function tool(name: string) {
    return defineAgentTool({
        name,
        returnType: Type.Object({}),
        execute: () => Promise.resolve({}),
        toLLM: () => [{ type: "text", text: "ok" }],
    });
}

describe("Agent", () => {
    it("merges instructions and tools from every feature in order", async () => {
        const searchTool = tool("search");
        const editTool = tool("edit");
        const provider = new ScriptedProvider([textTurn("answer")]);
        const searchFeature: AgentFeature = {
            instructions: () => "You can search.",
            tools: () => [searchTool],
        };
        const editFeature: AgentFeature = {
            instructions: () => "You can edit.",
            tools: () => [editTool],
        };
        const agent = new Agent(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            features: [searchFeature, editFeature],
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        const session = provider.sessions[0];
        expect(session?.options.instructions).toBe("You can search.\n\nYou can edit.");
        expect(session?.options.tools).toEqual([searchTool, editTool]);
        expect(session?.requests[0]?.context.instructions).toBe(
            "You can search.\n\nYou can edit.",
        );
        await agent.close();
    });

    it("fans events out to every feature in order", async () => {
        const seen: string[] = [];
        const observe = (name: string): AgentFeature => ({
            onEvent: (_hookCtx, event) => {
                if (event.type === "done") seen.push(name);
            },
        });
        const provider = new ScriptedProvider([textTurn("answer")]);
        const agent = new Agent(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            features: [observe("first"), observe("second")],
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        expect(seen).toEqual(["first", "second"]);
        await agent.close();
    });

    it("concatenates lifecycle actions from every feature", async () => {
        const provider = new ScriptedProvider([textTurn("first"), textTurn("second")]);
        let done = false;
        const followUp = (text: string): AgentFeature => ({
            afterTurn: () => {
                if (done) return undefined;
                return [{ type: "send", message: user(text) }];
            },
        });
        const stop: AgentFeature = {
            afterTurn: () => {
                done = true;
                return undefined;
            },
        };
        const agent = new Agent(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            sendMode: "all",
            features: [followUp("from first"), followUp("from second"), stop],
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        // Both features' actions were applied together and drained into one follow-up turn.
        const requests = provider.sessions[0]?.requests ?? [];
        expect(requests).toHaveLength(2);
        expect(requests[1]?.context.messages.slice(-2)).toEqual([
            user("from first"),
            user("from second"),
        ]);
        await agent.close();
    });

    it("lets the first answering feature win the reset injection while all observe the change", async () => {
        const provider = new ScriptedProvider([textTurn("claude"), textTurn("gpt")]);
        const observed: boolean[] = [];
        const silent: AgentFeature = {
            modelChanged: (_hookCtx, change) => {
                observed.push(change.wasReset);
                return undefined;
            },
        };
        const summarizer: AgentFeature = {
            modelChanged: () => system("summary"),
        };
        const late: AgentFeature = {
            modelChanged: (_hookCtx, change) => {
                observed.push(change.wasReset);
                return system("should lose");
            },
        };
        const agent = new Agent(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            model: "anthropic/claude",
            features: [silent, summarizer, late],
        });

        await agent.send(ctx, user("hello"));
        await agent.waitForIdle();
        await agent.send(ctx, user("switch"), { model: "openai/gpt" });
        await agent.waitForIdle();

        expect(observed).toEqual([true, true]);
        expect(provider.sessions[1]?.requests[0]?.context.messages).toEqual([
            system("summary"),
            user("switch"),
        ]);
        await agent.close();
    });

    it("keeps the base fallbacks when no feature implements a hook", async () => {
        const provider = new ScriptedProvider([textTurn("answer")]);
        const events: SessionEvent[] = [];
        const agent = new Agent(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            initialState: { instructions: "state instructions" },
            features: [{ onEvent: (_hookCtx, event) => events.push(event) }],
        });

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();

        // No feature implements instructions, so the mutable state answers as usual.
        expect(provider.sessions[0]?.requests[0]?.context.instructions).toBe(
            "state instructions",
        );
        expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
        await agent.close();
    });
});
