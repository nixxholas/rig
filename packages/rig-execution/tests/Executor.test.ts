import { testContext } from "./testContext.js";

import type { Context as RuntimeContext } from "@steve.kite/stdlib";
import {
    BaseProvider,
    BaseSession,
    type SessionCompaction,
    type SessionCompactionOptions,
    type SessionEvent,
    type SessionOptions,
    type SessionRunRequest,
} from "@slopus/happy-providers";
import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";

import { Executor } from "@/Executor.js";

const TEST_ENVIRONMENT = {
    osVersion: "25.0",
    platform: "darwin" as const,
    primaryWorkingDirectory: "/workspace",
    shell: "/bin/zsh",
};

describe("Executor", () => {
    it("creates the native session when compaction is the first operation", async () => {
        const native = new RecordingProvider();
        const executor = new Executor(
            [
                {
                    id: "codex",
                    native,
                    profiles: [profile("codex", "codex", "openai/sol", "Sol")],
                },
            ],
            { environment: TEST_ENVIRONMENT },
        );

        await expect(
            executor.compact(testContext, {
                context: {
                    messages: [{ role: "user", content: "Restored history.", timestamp: 1 }],
                },
                model: profile("codex", "codex", "openai/sol", "Sol").model,
            }),
        ).resolves.toMatchObject({ status: "completed" });
        expect(native.sessions).toHaveLength(1);
        expect(native.sessions.at(-1)?.compactionContexts).toEqual([testContext]);
        expect(native.sessions.at(-1)?.compactions).toEqual([
            {
                context: {
                    instructions: expect.any(String),
                    messages: [
                        {
                            role: "user",
                            content: [{ type: "text", text: "Restored history." }],
                        },
                    ],
                },
                model: "openai/sol",
            },
        ]);
    });

    it("propagates the caller context through the high-level stream", async () => {
        const native = new RecordingProvider();
        const model = profile("codex", "codex", "openai/sol", "Sol").model;
        const executor = new Executor(
            [{ id: "codex", native, profiles: [profile("codex", "codex", model.id, model.name)] }],
            { environment: TEST_ENVIRONMENT },
        );
        const turnCtx = testContext;

        const stream = executor.stream(turnCtx, model, {
            messages: [{ role: "user", content: "Do the work.", timestamp: 1 }],
        });
        for await (const _event of stream) {
            // Drain the normalized provider stream.
        }
        await stream.result();

        expect(native.sessions.at(-1)?.runContexts).toEqual([turnCtx]);
    });

    it("assembles prompts and preserves caller-owned tools while continuing compatible models", async () => {
        const native = new RecordingProvider();
        const executor = new Executor(
            [
                {
                    id: "codex",
                    native,
                    profiles: [
                        profile("codex", "codex", "openai/sol", "Sol"),
                        profile("codex", "codex", "openai/terra", "Terra"),
                    ],
                },
            ],
            { environment: TEST_ENVIRONMENT },
        );

        expect(
            await collect(
                executor.run(testContext, {
                    context: { messages: [] },
                    effort: "high",
                    tools: [tool("extra")],
                    selection: { modelId: "openai/sol", providerId: "codex" },
                    contextInstructions: "Dynamic instructions",
                }),
            ),
        ).toContainEqual({
            type: "done",
            state: "normal",
            tokens: { input: 0, output: 0 },
        });
        await collect(
            executor.run(testContext, {
                context: { messages: [] },
                tools: [tool("extra")],
                selection: { modelId: "openai/terra", providerId: "codex" },
                contextInstructions: "Dynamic instructions",
            }),
        );

        expect(native.sessions).toHaveLength(1);
        expect(native.sessions[0]?.requests.map((request) => request.model)).toEqual([
            "openai/sol",
            "openai/terra",
        ]);
        expect(native.options[0]?.tools?.map((candidate) => candidate.name)).toEqual(["extra"]);
        expect(native.options[0]?.instructions).toBe(
            [
                "You are Rig, built by Happy",
                "Sol",
                "",
                "# Environment",
                "- Primary working directory: /workspace",
                "- Platform: darwin",
                "- Shell: /bin/zsh",
                "- OS version: 25.0",
                "- Scratch directory: `.context/` in the working directory. Strongly prefer it for temporary files, throwaway scripts, and notes or instructions for other agents; keep it gitignored (add the entry if missing) unless there is a real reason not to, and never commit it.",
                "- By default the user sees only the last message you send before stopping; earlier messages are collapsed. Include all essential information in that last message.",
                "- When the project is a Git folder, a workspace and a worktree are the same thing: creating a workspace creates a new worktree, and deleting a workspace archives it.",
                "",
                "## Available models",
                "- Sol — model ID: `openai/sol`; provider ID: `codex`",
                "- Terra — model ID: `openai/terra`; provider ID: `codex`",
                "",
                "Dynamic instructions",
            ].join("\n"),
        );
        expect(
            native.options[0]?.modelConfigurations?.["openai/terra"]?.tools?.map(
                (candidate) => candidate.name,
            ),
        ).toEqual(["extra"]);
        expect(native.options[0]?.modelConfigurations?.["openai/terra"]?.instructions).toBe(
            [
                "You are Rig, built by Happy",
                "Terra",
                "",
                "# Environment",
                "- Primary working directory: /workspace",
                "- Platform: darwin",
                "- Shell: /bin/zsh",
                "- OS version: 25.0",
                "- Scratch directory: `.context/` in the working directory. Strongly prefer it for temporary files, throwaway scripts, and notes or instructions for other agents; keep it gitignored (add the entry if missing) unless there is a real reason not to, and never commit it.",
                "- By default the user sees only the last message you send before stopping; earlier messages are collapsed. Include all essential information in that last message.",
                "- When the project is a Git folder, a workspace and a worktree are the same thing: creating a workspace creates a new worktree, and deleting a workspace archives it.",
                "",
                "## Available models",
                "- Sol — model ID: `openai/sol`; provider ID: `codex`",
                "- Terra — model ID: `openai/terra`; provider ID: `codex`",
                "",
                "Dynamic instructions",
            ].join("\n"),
        );
        const compactContext = {
            messages: [{ role: "user" as const, content: "Selected prefix.", timestamp: 1 }],
        };
        await expect(
            executor.compact(testContext, {
                context: compactContext,
                instructions: "Keep decisions.",
                model: profile("codex", "codex", "openai/terra", "Terra").model,
            }),
        ).resolves.toMatchObject({
            status: "completed",
            summary: "summary",
            context: {
                messages: [
                    { role: "user", content: "Selected prefix.", timestamp: 1 },
                    { role: "user", content: "summary" },
                ],
            },
        });
        expect(native.sessions.at(-1)?.compactions).toEqual([
            {
                context: {
                    instructions: expect.any(String),
                    messages: [
                        {
                            role: "user",
                            content: [{ type: "text", text: "Selected prefix." }],
                        },
                    ],
                },
                instructions: "Keep decisions.",
                model: "openai/terra",
            },
        ]);
    });

    it("provides only tools with provider-compatible input schemas", async () => {
        const native = new RecordingProvider();
        const executor = new Executor(
            [
                {
                    id: "codex",
                    native,
                    profiles: [profile("codex", "codex", "openai/sol", "Sol")],
                },
            ],
            { environment: TEST_ENVIRONMENT },
        );

        await collect(
            executor.run(testContext, {
                context: { messages: [] },
                selection: { modelId: "openai/sol", providerId: "codex" },
                tools: [
                    {
                        ...tool("root-union"),
                        parameters: Type.Union([
                            Type.Object({ path: Type.String() }),
                            Type.Object({ url: Type.String() }),
                        ]),
                    },
                    {
                        ...tool("object"),
                        parameters: Type.Object({ path: Type.String() }),
                    },
                    tool("parameterless"),
                ],
            }),
        );

        expect(native.options[0]?.tools?.map((candidate) => candidate.name)).toEqual([
            "object",
            "parameterless",
        ]);
        expect(
            native.options[0]?.modelConfigurations?.["openai/sol"]?.tools?.map(
                (candidate) => candidate.name,
            ),
        ).toEqual(["object", "parameterless"]);
    });

    it("starts a fresh native session when context instructions change", async () => {
        const native = new RecordingProvider();
        const executor = new Executor(
            [
                {
                    id: "codex",
                    native,
                    profiles: [profile("codex", "codex", "openai/sol", "Sol")],
                },
            ],
            { environment: TEST_ENVIRONMENT },
        );

        await collect(
            executor.run(testContext, {
                context: { messages: [] },
                contextInstructions: "First context",
                selection: { modelId: "openai/sol", providerId: "codex" },
            }),
        );
        await collect(
            executor.run(testContext, {
                context: { messages: [] },
                contextInstructions: "Second context",
                selection: { modelId: "openai/sol", providerId: "codex" },
            }),
        );

        expect(native.sessions).toHaveLength(2);
        expect(native.options[0]?.instructions).toContain("First context");
        expect(native.options[1]?.instructions).toContain("Second context");
        expect(native.options[1]?.instructions).not.toContain("First context");
    });

    it("starts a fresh native session when the caller changes the tool catalog", async () => {
        const native = new RecordingProvider();
        const executor = new Executor(
            [
                {
                    id: "codex",
                    native,
                    profiles: [profile("codex", "codex", "openai/sol", "Sol")],
                },
            ],
            { environment: TEST_ENVIRONMENT },
        );

        await collect(
            executor.run(testContext, {
                context: { messages: [] },
                selection: { modelId: "openai/sol", providerId: "codex" },
                tools: [tool("read")],
            }),
        );
        await collect(
            executor.run(testContext, {
                context: { messages: [] },
                selection: { modelId: "openai/sol", providerId: "codex" },
                tools: [tool("write")],
            }),
        );

        expect(native.sessions).toHaveLength(2);
        expect(native.options[0]?.tools?.map((candidate) => candidate.name)).toEqual(["read"]);
        expect(native.options[1]?.tools?.map((candidate) => candidate.name)).toEqual(["write"]);
    });

    it("keeps the native session when tool schema object keys are reordered", async () => {
        const native = new RecordingProvider();
        const executor = new Executor(
            [
                {
                    id: "codex",
                    native,
                    profiles: [profile("codex", "codex", "openai/sol", "Sol")],
                },
            ],
            { environment: TEST_ENVIRONMENT },
        );
        const properties = {
            path: { type: "string" },
            offset: { type: "number" },
        };
        const first = {
            type: "object",
            properties,
            required: ["path", "offset"],
            additionalProperties: false,
        };
        const reordered = {
            additionalProperties: false,
            required: ["path", "offset"],
            properties: { offset: properties.offset, path: properties.path },
            type: "object",
        };

        for (const parameters of [first, reordered]) {
            await collect(
                executor.run(testContext, {
                    context: { messages: [] },
                    selection: { modelId: "openai/sol", providerId: "codex" },
                    tools: [{ ...tool("read"), parameters: parameters as never }],
                }),
            );
        }

        expect(native.sessions).toHaveLength(1);
    });

    it("replaces only the execution-owned base prompt", async () => {
        const native = new RecordingProvider();
        const executor = new Executor(
            [
                {
                    id: "codex",
                    native,
                    profiles: [profile("codex", "codex", "openai/sol", "Sol")],
                },
            ],
            { environment: TEST_ENVIRONMENT },
        );

        await collect(
            executor.run(testContext, {
                context: { messages: [] },
                contextInstructions: "AGENTS instructions",
                selection: { modelId: "openai/sol", providerId: "codex" },
                systemPrompt: "Custom base for {{name}}",
            }),
        );

        const instructions = native.options[0]?.instructions ?? "";
        expect(instructions).toContain("Custom base for Rig");
        expect(instructions).not.toContain("You are Rig, built by Happy");
        expect(instructions).not.toContain("\nSol\n");
        expect(instructions).toContain("# Environment");
        expect(instructions).toContain("AGENTS instructions");
    });

    it("serializes concurrent first-run session creation", async () => {
        const native = new RecordingProvider();
        const executor = new Executor(
            [
                {
                    id: "codex",
                    native,
                    profiles: [profile("codex", "codex", "openai/sol", "Sol")],
                },
            ],
            { environment: TEST_ENVIRONMENT },
        );
        const request = {
            context: { messages: [] },
            selection: { modelId: "openai/sol", providerId: "codex" },
        };

        await Promise.all([
            collect(executor.run(testContext, request)),
            collect(executor.run(testContext, request)),
        ]);

        expect(native.sessions).toHaveLength(1);
    });

    it("serializes the complete inference lifecycle", async () => {
        let releaseFirst = () => {};
        const firstGate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        let resolveFirstStarted = () => {};
        const firstStarted = new Promise<void>((resolve) => {
            resolveFirstStarted = resolve;
        });
        let activeInferences = 0;
        let maximumActiveInferences = 0;
        let startedInferences = 0;
        class SerialSession extends BaseSession {
            constructor(id: string) {
                super(id);
            }

            override async compact(_ctx: RuntimeContext): Promise<SessionCompaction> {
                throw new Error("Not used");
            }

            override destroy(): void {}

            override async *run(_ctx: RuntimeContext): AsyncGenerator<SessionEvent> {
                startedInferences += 1;
                activeInferences += 1;
                maximumActiveInferences = Math.max(maximumActiveInferences, activeInferences);
                try {
                    if (startedInferences === 1) {
                        resolveFirstStarted();
                        await firstGate;
                    }
                    yield { type: "done", state: "normal", tokens: { input: 0, output: 0 } };
                } finally {
                    activeInferences -= 1;
                }
            }
        }
        class SerialProvider extends BaseProvider {
            static override readonly name = "serial";
            static override readonly inputTypes = ["text"] as const;
            static override readonly outputTypes = ["text"] as const;
            readonly sessionInstance = new SerialSession("serial-session");

            override async session() {
                return this.sessionInstance;
            }
        }
        const native = new SerialProvider();
        const executor = new Executor(
            [
                {
                    id: "codex",
                    native,
                    profiles: [profile("codex", "codex", "openai/sol", "Sol")],
                },
            ],
            { environment: TEST_ENVIRONMENT },
        );
        const request = {
            context: { messages: [] },
            selection: { modelId: "openai/sol", providerId: "codex" },
        };

        const first = collect(executor.run(testContext, request));
        await firstStarted;
        const second = collect(executor.run(testContext, request));
        await Promise.resolve();
        expect(startedInferences).toBe(1);
        releaseFirst();
        await Promise.all([first, second]);

        expect(startedInferences).toBe(2);
        expect(maximumActiveInferences).toBe(1);
    });

    it("substitutes the configured identity inside execution-owned prompts", async () => {
        const native = new RecordingProvider();
        const executor = new Executor(
            [
                {
                    id: "codex",
                    native,
                    profiles: [
                        {
                            ...profile("codex", "codex", "openai/sol", "Sol"),
                            prompt: "{{identity}}\nAgent name: {{name}}\nSol",
                        },
                    ],
                },
            ],
            {
                environment: TEST_ENVIRONMENT,
                identity: {
                    name: "Acme",
                    prompt: "Follow Acme's coding standards.",
                },
            },
        );

        await collect(
            executor.run(testContext, {
                context: { messages: [] },
                selection: { modelId: "openai/sol", providerId: "codex" },
            }),
        );

        expect(native.options[0]?.instructions).toContain(
            "Follow Acme's coding standards.\nAgent name: Acme\nSol",
        );
        expect(native.options[0]?.instructions).not.toContain("You are Acme");
        expect(native.options[0]?.instructions).not.toContain("You are Rig");
    });

    it("requires reset before an incompatible selection and does not infer", async () => {
        const native = new RecordingProvider();
        const executor = new Executor(
            [
                {
                    id: "codex",
                    native,
                    profiles: [profile("codex", "codex", "openai/sol", "Sol")],
                },
                {
                    id: "claude",
                    native,
                    profiles: [profile("claude", "claude", "anthropic/sonnet", "Sonnet")],
                },
            ],
            { environment: TEST_ENVIRONMENT },
        );
        await collect(
            executor.run(testContext, {
                context: { messages: [] },
                selection: { modelId: "openai/sol", providerId: "codex" },
            }),
        );

        const events = await collect(
            executor.run(testContext, {
                context: { messages: [] },
                selection: { modelId: "anthropic/sonnet", providerId: "claude" },
            }),
        );
        expect(events).toEqual([
            expect.objectContaining({
                type: "reset_required",
                requested: { modelId: "anthropic/sonnet", providerId: "claude" },
            }),
        ]);
        expect(native.sessions).toHaveLength(1);

        await executor.reset({ modelId: "anthropic/sonnet", providerId: "claude" });
        await collect(
            executor.run(testContext, {
                context: { messages: [] },
                selection: { modelId: "anthropic/sonnet", providerId: "claude" },
            }),
        );
        expect(native.sessions).toHaveLength(2);
    });

    it("isolates side inference without taking ownership of parent provider teardown", async () => {
        const native = new RecordingProvider();
        let teardownCount = 0;
        const executor = new Executor(
            [
                {
                    destroy: () => {
                        teardownCount += 1;
                    },
                    id: "codex",
                    native,
                    profiles: [profile("codex", "codex", "openai/sol", "Sol")],
                    sessionId: "conversation",
                },
            ],
            { environment: TEST_ENVIRONMENT },
        );
        await collect(
            executor.run(testContext, {
                context: { messages: [] },
                selection: { modelId: "openai/sol", providerId: "codex" },
            }),
        );

        const isolated = executor.isolate("title");
        await collect(
            isolated.run(testContext, {
                context: { messages: [] },
                selection: { modelId: "openai/sol", providerId: "codex" },
            }),
        );
        await isolated.close();

        expect(native.sessions.map((session) => session.id)).toEqual([
            "conversation",
            "conversation:title",
        ]);
        expect(teardownCount).toBe(0);

        await executor.close();
        expect(teardownCount).toBe(1);
    });

    it("force-closes an isolated session without waiting behind ignored inference abort", async () => {
        const native = new ForceCloseProvider();
        const executor = new Executor(
            [
                {
                    id: "codex",
                    native,
                    profiles: [profile("codex", "codex", "openai/sol", "Sol")],
                    sessionId: "conversation",
                },
            ],
            { environment: TEST_ENVIRONMENT },
        );
        const isolated = executor.isolate("title");
        const running = collect(
            isolated.run(testContext, {
                abort: AbortSignal.abort(),
                context: { messages: [] },
                selection: { modelId: "openai/sol", providerId: "codex" },
            }),
        );
        await vi.waitFor(() => expect(native.sessions[0]?.running).toBe(true));

        await isolated.forceClose();
        await running;

        expect(native.sessions[0]?.destroyed).toBe(true);
    });

    it("asks a bounded question on the bare provider without the coding agent or its session", async () => {
        const native = new AnsweringProvider("<title>Named from the bare provider</title>");
        const executor = new Executor(
            [
                {
                    id: "codex",
                    native,
                    profiles: [profile("codex", "codex", "openai/sol", "Sol")],
                    sessionId: "conversation",
                },
            ],
            { environment: TEST_ENVIRONMENT },
        );
        await collect(
            executor.run(testContext, {
                context: {
                    messages: [{ role: "user", content: [{ type: "text", text: "Do the work." }] }],
                },
                selection: { modelId: "openai/sol", providerId: "codex" },
            }),
        );

        const answer = await executor.rawQuery(testContext, {
            instructions: "Name this chat.",
            model: profile("codex", "codex", "openai/sol", "Sol").model,
            prompt: "User: Name this chat.",
            sessionId: "conversation:title",
        });

        expect(answer).toBe("<title>Named from the bare provider</title>");
        // The question got its own vendor session, holding exactly the instructions it was given.
        expect(native.options).toHaveLength(2);
        expect(native.options[1]).toEqual({ instructions: "Name this chat.", tools: [] });
        expect(native.sessions[1]?.id).toBe("conversation:title");
        expect(native.sessions[1]?.runContexts).toEqual([testContext]);
        expect(native.sessions[1]?.destroyed).toBe(true);
        expect(native.sessions[1]?.requests[0]?.context.messages).toEqual([
            { role: "user", content: [{ type: "text", text: "User: Name this chat." }] },
        ]);
        // Nothing of the agent's own prompt or conversation went along, and its session survived.
        expect(JSON.stringify(native.options[1])).not.toContain("Sol");
        expect(JSON.stringify(native.sessions[1]?.requests)).not.toContain("Do the work.");
        expect(native.sessions[0]?.destroyed).toBe(false);
        expect(executor.hasActiveSession).toBe(true);
    });

    it("reports the provider's own failure rather than an empty answer", async () => {
        const native = new AnsweringProvider("", {
            kind: "unknown",
            message: "The account is out of capacity.",
            state: "error",
            type: "done",
        });
        const executor = new Executor(
            [
                {
                    id: "codex",
                    native,
                    profiles: [profile("codex", "codex", "openai/sol", "Sol")],
                },
            ],
            { environment: TEST_ENVIRONMENT },
        );

        await expect(
            executor.rawQuery(testContext, {
                instructions: "Name this chat.",
                model: profile("codex", "codex", "openai/sol", "Sol").model,
                prompt: "User: Name this chat.",
                sessionId: "conversation:title",
            }),
        ).rejects.toThrow("The account is out of capacity.");
        expect(native.sessions[0]?.destroyed).toBe(true);
    });
});

class AnsweringProvider extends BaseProvider {
    static override readonly name = "answering";
    static override readonly inputTypes = ["text"] as const;
    static override readonly outputTypes = ["text"] as const;
    readonly options: SessionOptions[] = [];
    readonly sessions: AnsweringSession[] = [];

    constructor(
        private readonly answer: string,
        private readonly terminal: Extract<SessionEvent, { type: "done" }> = {
            state: "normal",
            tokens: { input: 0, output: 0 },
            type: "done",
        },
    ) {
        super();
    }

    override async session(id: string, options: SessionOptions) {
        this.options.push(options);
        const session = new AnsweringSession(id, this.answer, this.terminal);
        this.sessions.push(session);
        return session;
    }
}

class AnsweringSession extends BaseSession {
    destroyed = false;
    readonly requests: SessionRunRequest[] = [];
    readonly runContexts: RuntimeContext[] = [];

    constructor(
        id: string,
        private readonly answer: string,
        private readonly terminal: Extract<SessionEvent, { type: "done" }>,
    ) {
        super(id);
    }

    override async compact(_ctx: RuntimeContext): Promise<SessionCompaction> {
        throw new Error("Bounded questions never compact.");
    }

    override destroy(): void {
        this.destroyed = true;
    }

    override async *run(
        ctx: RuntimeContext,
        request: SessionRunRequest,
    ): AsyncGenerator<SessionEvent> {
        this.runContexts.push(ctx);
        this.requests.push(request);
        if (this.answer.length > 0) yield { type: "text_delta", delta: this.answer };
        yield this.terminal;
    }
}

class RecordingProvider extends BaseProvider {
    static override readonly name = "recording";
    static override readonly inputTypes = ["text"] as const;
    static override readonly outputTypes = ["text"] as const;
    readonly options: SessionOptions[] = [];
    readonly sessions: RecordingSession[] = [];

    override async session(id: string, options: SessionOptions) {
        this.options.push(options);
        const session = new RecordingSession(id);
        this.sessions.push(session);
        return session;
    }
}

class RecordingSession extends BaseSession {
    readonly compactionContexts: RuntimeContext[] = [];
    readonly compactions: SessionCompactionOptions[] = [];
    readonly runContexts: RuntimeContext[] = [];
    readonly requests: SessionRunRequest[] = [];

    constructor(id: string) {
        super(id);
    }

    override async compact(
        ctx: RuntimeContext,
        options: SessionCompactionOptions,
    ): Promise<SessionCompaction> {
        this.compactionContexts.push(ctx);
        this.compactions.push(options);
        const preservedMessages = options.context.messages;
        return {
            status: "completed",
            summary: "summary",
            preservedMessages,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
            context: {
                instructions: options.context.instructions,
                messages: [
                    ...preservedMessages,
                    { role: "user", content: [{ type: "text", text: "summary" }] },
                ],
            },
        };
    }

    override destroy(): void {}

    override async *run(
        ctx: RuntimeContext,
        request: SessionRunRequest,
    ): AsyncGenerator<SessionEvent> {
        this.runContexts.push(ctx);
        this.requests.push(request);
        yield { type: "done", state: "normal", tokens: { input: 0, output: 0 } };
    }
}

class ForceCloseProvider extends BaseProvider {
    static override readonly name = "force-close";
    static override readonly inputTypes = ["text"] as const;
    static override readonly outputTypes = ["text"] as const;
    readonly sessions: ForceCloseSession[] = [];

    override async session(id: string) {
        const session = new ForceCloseSession(id);
        this.sessions.push(session);
        return session;
    }
}

class ForceCloseSession extends BaseSession {
    destroyed = false;
    running = false;
    readonly #stopped: Promise<void>;
    #stop: (() => void) | undefined;

    constructor(id: string) {
        super(id);
        this.#stopped = new Promise<void>((resolve) => {
            this.#stop = resolve;
        });
    }

    override async compact(_ctx: RuntimeContext): Promise<SessionCompaction> {
        throw new Error("Not used");
    }

    override destroy(): void {
        this.destroyed = true;
        this.#stop?.();
    }

    override async *run(_ctx: RuntimeContext): AsyncGenerator<SessionEvent> {
        this.running = true;
        await this.#stopped;
        yield { type: "done", state: "cancelled" };
    }
}

function profile(providerId: string, providerType: "claude" | "codex", id: string, name: string) {
    return {
        id,
        model: {
            defaultThinkingLevel: "off",
            id,
            name,
            thinkingLevels: ["off"],
        },
        name,
        providerId,
        providerType,
        prompt: `{{identity}}\n${name}`,
    };
}

function tool(name: string) {
    return {
        description: name,
        name,
    };
}

async function collect(events: AsyncIterable<SessionEvent | { type: "reset_required" }>) {
    const collected: unknown[] = [];
    for await (const event of events) collected.push(event);
    return collected;
}
