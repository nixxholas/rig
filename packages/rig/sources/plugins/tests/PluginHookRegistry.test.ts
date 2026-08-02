import { describe, expect, it, vi } from "vitest";

import {
    HAPPY_PLUGIN_TRACING_QUEUE_SIZE,
    type HappySystemPromptHookEvent,
    type HappyTracingEvent,
} from "happy-plugins";

import { PluginHookRegistry } from "../PluginHookRegistry.js";

describe("PluginHookRegistry", () => {
    it("chains system-prompt replacements by plugin folder name", async () => {
        const registry = new PluginHookRegistry();
        const second = registry.createConnection({ folder: "z-last", name: "Last" });
        const first = registry.createConnection({ folder: "a-first", name: "First" });
        attachPrompt(first, (event) => `${event.input.systemPrompt}\nfirst`);
        attachPrompt(second, (event) => `${event.input.systemPrompt}\nlast`);

        await expect(
            registry.applySystemPrompt({
                systemPrompt: "base",
                userPrompt: "Ship it.",
            }),
        ).resolves.toBe("base\nfirst\nlast");
    });

    it("skips a deadline miss and continues the middleware chain", async () => {
        const log = vi.fn();
        const registry = new PluginHookRegistry({ deadlineMs: 5, log });
        const silent = registry.createConnection({ folder: "a-silent", name: "Silent" });
        const next = registry.createConnection({ folder: "b-next", name: "Next" });
        const silentId = silent.registerSystemPrompt();
        silent.attachSystemPrompt(silentId, () => true);
        attachPrompt(next, (event) => `${event.input.systemPrompt}\ncontinued`);

        await expect(
            registry.applySystemPrompt({ systemPrompt: "base", userPrompt: "Continue." }),
        ).resolves.toBe("base\ncontinued");
        expect(log).toHaveBeenCalledWith(
            "warning",
            "plugin_system_prompt_hook_missed",
            expect.stringContaining("Silent"),
            expect.objectContaining({ pluginFolder: "a-silent" }),
        );
    });

    it("waits for a completion when the stream write reports buffered backpressure", async () => {
        const log = vi.fn();
        const registry = new PluginHookRegistry({ deadlineMs: 50, log });
        const connection = registry.createConnection({ folder: "buffered", name: "Buffered" });
        const id = connection.registerSystemPrompt();
        connection.attachSystemPrompt(id, (event) => {
            queueMicrotask(() => {
                connection.completeSystemPrompt(id, event.callId, {
                    result: { systemPrompt: `${event.input.systemPrompt}\nbuffered` },
                });
            });
            return false;
        });

        await expect(
            registry.applySystemPrompt({ systemPrompt: "base", userPrompt: "Continue." }),
        ).resolves.toBe("base\nbuffered");
        expect(log).not.toHaveBeenCalledWith(
            "warning",
            "plugin_system_prompt_hook_missed",
            expect.anything(),
            expect.anything(),
        );
    });

    it("retires detached streams so the same plugin can register again", () => {
        const log = vi.fn();
        const registry = new PluginHookRegistry({ log });
        const connection = registry.createConnection({ folder: "recover", name: "Recover" });
        const hookId = connection.registerSystemPrompt();
        const detachHook = connection.attachSystemPrompt(hookId, () => {});
        const tracingId = connection.registerTracing();
        const detachTracing = connection.attachTracing(tracingId, () => true);

        detachHook();
        detachTracing();

        expect(connection.registerSystemPrompt()).not.toBe(hookId);
        expect(connection.registerTracing()).not.toBe(tracingId);
        expect(log).toHaveBeenCalledWith(
            "warning",
            "plugin_system_prompt_stream_closed",
            expect.stringContaining("Recover"),
            expect.objectContaining({ pluginFolder: "recover" }),
        );
        expect(log).toHaveBeenCalledWith(
            "warning",
            "plugin_tracing_stream_closed",
            expect.stringContaining("Recover"),
            expect.objectContaining({ pluginFolder: "recover" }),
        );
    });

    it("supersedes an old process generation before its close callback finishes", async () => {
        const registry = new PluginHookRegistry();
        const old = registry.createConnection({ folder: "same", name: "Old" });
        attachPrompt(old, (event) => `${event.input.systemPrompt}\nold`);
        const replacement = registry.createConnection({ folder: "same", name: "New" });
        attachPrompt(replacement, (event) => `${event.input.systemPrompt}\nnew`);

        expect(old.generation).not.toBe(replacement.generation);
        await expect(
            registry.applySystemPrompt({ systemPrompt: "base", userPrompt: "Continue." }),
        ).resolves.toBe("base\nnew");
    });

    it("bounds the aggregate middleware chain and skips remaining hooks with a log", async () => {
        const log = vi.fn();
        const timestamps = [0, 0, 5];
        const registry = new PluginHookRegistry({
            chainDeadlineMs: 5,
            deadlineMs: 50,
            log,
            now: () => timestamps.shift() ?? 5,
        });
        const silent = registry.createConnection({ folder: "a-silent", name: "Silent" });
        const silentId = silent.registerSystemPrompt();
        silent.attachSystemPrompt(silentId, () => {});
        const remaining = registry.createConnection({ folder: "b-remaining", name: "Remaining" });
        const remainingCall = vi.fn();
        const remainingId = remaining.registerSystemPrompt();
        remaining.attachSystemPrompt(remainingId, remainingCall);

        await expect(
            registry.applySystemPrompt({ systemPrompt: "base", userPrompt: "Continue." }),
        ).resolves.toBe("base");
        expect(remainingCall).not.toHaveBeenCalled();
        expect(log).toHaveBeenCalledWith(
            "warning",
            "plugin_system_prompt_chain_budget_exhausted",
            expect.stringContaining("chain deadline"),
            { skippedCount: 1 },
        );
    });

    it("delivers tracing observations synchronously without awaiting plugin work", () => {
        const registry = new PluginHookRegistry();
        const connection = registry.createConnection({ folder: "trace", name: "Trace" });
        const id = connection.registerTracing();
        const received: HappyTracingEvent[] = [];
        connection.attachTracing(id, (event) => {
            received.push(event);
            return true;
        });
        const event = turnStarted(1);

        expect(() => registry.emit(event)).not.toThrow();
        expect(received).toEqual([event]);
    });

    it("drops the oldest tracing events under backpressure and logs the drop count", () => {
        const log = vi.fn();
        const registry = new PluginHookRegistry({ log });
        const connection = registry.createConnection({ folder: "slow", name: "Slow" });
        const id = connection.registerTracing();
        let reading = false;
        const received: HappyTracingEvent[] = [];
        connection.attachTracing(id, (event) => {
            if (!reading) return false;
            received.push(event);
            return true;
        });
        registry.emit(turnStarted(-1));
        const total = HAPPY_PLUGIN_TRACING_QUEUE_SIZE + 7;
        for (let index = 0; index < total; index += 1) registry.emit(turnStarted(index));

        reading = true;
        connection.drainTracing(id);

        expect(received).toHaveLength(HAPPY_PLUGIN_TRACING_QUEUE_SIZE);
        expect(received[0]?.timestamp).toBe(7);
        expect(received.at(-1)?.timestamp).toBe(total - 1);
        expect(log).toHaveBeenCalledWith(
            "warning",
            "plugin_tracing_events_dropped",
            expect.stringContaining("1 tracing events"),
            expect.objectContaining({ droppedCount: 1, pluginFolder: "slow" }),
        );
    });
});

function attachPrompt(
    connection: ReturnType<PluginHookRegistry["createConnection"]>,
    replace: (event: HappySystemPromptHookEvent) => string,
): void {
    const id = connection.registerSystemPrompt();
    connection.attachSystemPrompt(id, (event) => {
        connection.completeSystemPrompt(id, event.callId, {
            result: { systemPrompt: replace(event) },
        });
        return true;
    });
}

function turnStarted(timestamp: number): HappyTracingEvent {
    return {
        model: "openai/gpt-test",
        provider: "codex",
        sessionId: "session-1",
        timestamp,
        type: "turn_started",
    };
}
