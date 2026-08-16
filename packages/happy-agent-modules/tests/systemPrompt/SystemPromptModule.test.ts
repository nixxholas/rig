import {
    withAgentConfig,
    type AgentModuleAgent,
    type AgentModuleScope,
} from "@slopus/happy-agent-base";
import type { ProviderModelCompatibilityType } from "@slopus/happy-providers";
import { Value } from "@sinclair/typebox/value";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { AGENTS_MD_SPEC } from "../../sources/systemPrompt/AgentsMd.js";
import {
    SystemPromptModule,
    MAX_SYSTEM_PROMPT_OUTPUT_BYTES,
    MAX_SYSTEM_PROMPT_AVAILABLE_MODELS_BYTES,
    MAX_SYSTEM_PROMPT_AVAILABLE_MODELS,
    systemPromptModuleOptionsSchema,
    systemPromptSelectionSchema,
} from "../../sources/systemPrompt/SystemPromptModule.js";
import { systemPromptIdentitySchema } from "../../sources/systemPrompt/SystemPromptIdentity.js";
import {
    systemPromptAvailableModelSchema,
    systemPromptAvailableModelsSchema,
} from "../../sources/systemPrompt/SystemPromptAvailableModel.js";
import { formatAvailableModels } from "../../sources/systemPrompt/impl/assembleEnvironmentPrompt.js";
import { systemPromptForModel } from "../../sources/systemPrompt/impl/systemPromptForModel.js";
import { FakeCompute } from "../compute/support/FakeCompute.js";

const ctx: Context = createRootContext();
const testEnvironment = {
    osVersion: "25.5.0",
    platform: "darwin" as const,
    workingDirectory: "/workspace",
    shell: "/bin/zsh",
};

/** A scope naming only what the module reads: which model the agent is running on. */
function scopeOf(
    model: string | undefined,
    providerKind: ProviderModelCompatibilityType | undefined,
): AgentModuleScope {
    const agent: AgentModuleAgent = {
        effort: undefined,
        id: "agent",
        metadata: undefined,
        model,
        permissionMode: "auto",
        provider: "provider",
        providerKind,
        tier: undefined,
    };
    return { agent } as AgentModuleScope;
}

function contextWithEnvironment(environment = testEnvironment): Context {
    return withAgentConfig(ctx, { environment });
}

function catalogWithBytes(targetBytes: number) {
    const fieldLength = 158;
    const catalog = Array.from({ length: MAX_SYSTEM_PROMPT_AVAILABLE_MODELS }, () => ({
        name: "x".repeat(fieldLength),
        id: "x".repeat(fieldLength),
        providerId: "x".repeat(fieldLength),
    }));
    const baseBytes = new TextEncoder().encode(formatAvailableModels(catalog)).byteLength;
    let remaining = targetBytes - baseBytes;
    if (remaining < 0 || remaining > (256 - fieldLength) * catalog.length) {
        throw new Error("The test catalog target is outside the available adjustment range.");
    }
    for (let index = 0; remaining > 0; index += 1) {
        const added = Math.min(256 - fieldLength, remaining);
        catalog[index]!.name = "x".repeat(fieldLength + added);
        remaining -= added;
    }
    return catalog;
}

describe("SystemPromptModule", () => {
    it("gives each model the prompt it was written for", async () => {
        const module = new SystemPromptModule();

        const opus5 = await module.instructions(ctx, scopeOf("anthropic/opus-5", "claude"));
        const opus48 = await module.instructions(ctx, scopeOf("anthropic/opus-4-8", "claude"));
        const codex = await module.instructions(ctx, scopeOf("openai/gpt-5.6-sol", "codex"));

        expect(opus5).toContain("mid-conversation system turns");
        expect(opus48).not.toContain("mid-conversation system turns");
        expect(opus5).not.toBe(opus48);
        expect(codex).not.toBe(opus5);
        expect(codex.length).toBeGreaterThan(0);
    });

    it("follows the model rather than the provider it is served through", async () => {
        const module = new SystemPromptModule();

        expect(await module.instructions(ctx, scopeOf("anthropic/opus-5", "bedrock"))).toBe(
            await module.instructions(ctx, scopeOf("anthropic/opus-5", "claude")),
        );
        expect(await module.instructions(ctx, scopeOf("xai/grok-build", "grok"))).toBe(
            await module.instructions(ctx, scopeOf("xai/grok-4.5", "grok")),
        );
    });

    it("falls back to the provider's family when the model is unknown or absent", async () => {
        const module = new SystemPromptModule();

        expect(await module.instructions(ctx, scopeOf("openai/gpt-9-unreleased", "codex"))).toBe(
            await module.instructions(ctx, scopeOf("openai/gpt-5.6-sol", "codex")),
        );
        expect(await module.instructions(ctx, scopeOf(undefined, "grok"))).toBe(
            await module.instructions(ctx, scopeOf("xai/grok-4.5", "grok")),
        );
    });

    it("falls back to the simple prompt when nothing was written for the model", async () => {
        const module = new SystemPromptModule();

        const unknown = await module.instructions(ctx, scopeOf("mystery/model", "gym"));

        expect(unknown).toContain("You are an expert coding assistant.");
        expect(unknown.startsWith("You are Rig, built by Happy")).toBe(true);
        expect(await module.instructions(ctx, scopeOf(undefined, undefined))).toBe(unknown);
    });

    it("substitutes the identity it was built with", async () => {
        const named = new SystemPromptModule({
            identity: { name: "Scout", prompt: "You are Scout, built by Happy" },
        });

        const [claudePrompt, codexPrompt] = await Promise.all([
            named.instructions(ctx, scopeOf("anthropic/opus-5", "claude")),
            named.instructions(ctx, scopeOf("openai/gpt-5.6-sol", "codex")),
        ]);

        for (const prompt of [claudePrompt, codexPrompt]) {
            expect(prompt.startsWith("You are Scout, built by Happy")).toBe(true);
            expect(prompt).not.toContain("{{identity}}");
            expect(prompt).not.toContain("{{name}}");
        }
        expect(codexPrompt).toContain("As Scout,");
    });

    it("substitutes replacement-string metacharacters literally", async () => {
        for (const value of ["$&", "$`", "$'"]) {
            const prompt = await new SystemPromptModule({
                identity: { name: value, prompt: value },
            }).instructions(ctx, scopeOf("anthropic/opus-5", "claude"));

            expect(prompt.startsWith(value)).toBe(true);
            expect(prompt).toContain(value);
            expect(prompt).not.toContain("{{identity}}");
            expect(prompt).not.toContain("{{name}}");
        }
    });

    it("names Rig when the host names nobody", async () => {
        const module = new SystemPromptModule();
        const [claudePrompt, codexPrompt] = await Promise.all([
            module.instructions(ctx, scopeOf("anthropic/opus-5", "claude")),
            module.instructions(ctx, scopeOf("openai/gpt-5.6-sol", "codex")),
        ]);

        expect(claudePrompt.startsWith("You are Rig, built by Happy")).toBe(true);
        expect(codexPrompt.startsWith("You are Rig, built by Happy")).toBe(true);
        expect(codexPrompt).toContain("As Rig,");
    });

    it("appends the machine environment and every injected model route", async () => {
        const module = new SystemPromptModule({
            availableModels: [
                { name: "Claude Opus", id: "anthropic/opus-5", providerId: "anthropic" },
                { name: "Codex", id: "openai/gpt-5.6-sol", providerId: "openai" },
            ],
        });

        const prompt = await module.instructions(
            contextWithEnvironment(),
            scopeOf("anthropic/opus-5", "claude"),
        );

        expect(prompt).toContain("# Environment");
        expect(prompt).toContain("- Primary working directory: /workspace");
        expect(prompt).toContain("- Platform: darwin");
        expect(prompt).toContain("- Shell: /bin/zsh");
        expect(prompt).toContain("- OS version: 25.5.0");
        expect(prompt).toContain(
            "- Scratch directory: `.context/` in the working directory. Strongly prefer it",
        );
        expect(prompt).toContain(
            "- By default the user sees only the last message you send before stopping;",
        );
        expect(prompt).toContain(
            "- When the project is a Git folder, a workspace and a worktree are the same thing:",
        );
        expect(prompt).toContain(
            "## Available models\n- Claude Opus — model ID: `anthropic/opus-5`; provider ID: `anthropic`\n- Codex — model ID: `openai/gpt-5.6-sol`; provider ID: `openai`",
        );
    });

    it("omits the environment section when the context has no environment", async () => {
        const module = new SystemPromptModule({
            availableModels: [
                { name: "Claude Opus", id: "anthropic/opus-5", providerId: "anthropic" },
            ],
        });
        const selection = { model: "anthropic/opus-5", providerKind: "claude" as const };

        const prompt = await module.instructions(
            ctx,
            scopeOf(selection.model, selection.providerKind),
        );

        expect(prompt).toBe([module.promptFor(selection), AGENTS_MD_SPEC].join("\n\n"));
        expect(prompt).not.toContain("# Environment");
    });

    it("omits blank shell and empty available-model sections", async () => {
        const prompt = await new SystemPromptModule().instructions(
            contextWithEnvironment({ ...testEnvironment, shell: "" }),
            scopeOf("anthropic/opus-5", "claude"),
        );

        expect(prompt).not.toContain("- Shell:");
        expect(prompt).not.toContain("## Available models");
    });

    it("renders the complete legacy environment text in its exact order", async () => {
        const module = new SystemPromptModule({
            availableModels: [
                { name: "Claude Opus", id: "anthropic/opus-5", providerId: "anthropic" },
                { name: "Codex", id: "openai/gpt-5.6-sol", providerId: "openai" },
            ],
        });
        const selection = { model: "anthropic/opus-5", providerKind: "claude" as const };
        const expectedEnvironment = [
            "# Environment",
            "- Primary working directory: /workspace",
            "- Platform: darwin",
            "- Shell: /bin/zsh",
            "- OS version: 25.5.0",
            "- Scratch directory: `.context/` in the working directory. Strongly prefer it for temporary files, throwaway scripts, and notes or instructions for other agents; keep it gitignored (add the entry if missing) unless there is a real reason not to, and never commit it.",
            "- By default the user sees only the last message you send before stopping; earlier messages are collapsed. Include all essential information in that last message.",
            "- When the project is a Git folder, a workspace and a worktree are the same thing: creating a workspace creates a new worktree, and deleting a workspace archives it.",
            "",
            "## Available models",
            "- Claude Opus — model ID: `anthropic/opus-5`; provider ID: `anthropic`",
            "- Codex — model ID: `openai/gpt-5.6-sol`; provider ID: `openai`",
        ].join("\n");

        expect(
            await module.instructions(
                contextWithEnvironment(),
                scopeOf(selection.model, selection.providerKind),
            ),
        ).toBe([module.promptFor(selection), expectedEnvironment, AGENTS_MD_SPEC].join("\n\n"));
    });

    it("substitutes identity before appending an environment", async () => {
        const module = new SystemPromptModule({
            identity: { name: "Scout", prompt: "You are Scout, built by Happy" },
            availableModels: [{ name: "Codex", id: "openai/gpt-5.6-sol", providerId: "openai" }],
        });

        const prompt = await module.instructions(
            contextWithEnvironment(),
            scopeOf("openai/gpt-5.6-sol", "codex"),
        );

        expect(prompt.startsWith("You are Scout, built by Happy")).toBe(true);
        expect(prompt).toContain("As Scout,");
        expect(prompt).toContain("# Environment");
        expect(prompt).not.toContain("{{identity}}");
        expect(prompt).not.toContain("{{name}}");
    });

    it("accepts the exact catalog byte boundary and rejects the next byte", () => {
        const below = catalogWithBytes(MAX_SYSTEM_PROMPT_AVAILABLE_MODELS_BYTES - 1);
        const equal = catalogWithBytes(MAX_SYSTEM_PROMPT_AVAILABLE_MODELS_BYTES);
        const above = catalogWithBytes(MAX_SYSTEM_PROMPT_AVAILABLE_MODELS_BYTES + 1);

        expect(new TextEncoder().encode(formatAvailableModels(below)).byteLength).toBe(
            MAX_SYSTEM_PROMPT_AVAILABLE_MODELS_BYTES - 1,
        );
        expect(new TextEncoder().encode(formatAvailableModels(equal)).byteLength).toBe(
            MAX_SYSTEM_PROMPT_AVAILABLE_MODELS_BYTES,
        );
        expect(new TextEncoder().encode(formatAvailableModels(above)).byteLength).toBe(
            MAX_SYSTEM_PROMPT_AVAILABLE_MODELS_BYTES + 1,
        );
        expect(() => new SystemPromptModule({ availableModels: below })).not.toThrow();
        expect(() => new SystemPromptModule({ availableModels: equal })).not.toThrow();
        expect(() => new SystemPromptModule({ availableModels: above })).toThrow(
            "System prompt available models exceed the configured UTF-8 byte bound",
        );
    });

    it("rejects catalogs that exceed the item or Unicode UTF-8 bounds", () => {
        const plainModel = { name: "Model", id: "model", providerId: "provider" };
        const maximumModels = Array.from(
            { length: MAX_SYSTEM_PROMPT_AVAILABLE_MODELS },
            () => plainModel,
        );
        expect(() => new SystemPromptModule({ availableModels: maximumModels })).not.toThrow();

        const tooManyModels = Array.from(
            { length: MAX_SYSTEM_PROMPT_AVAILABLE_MODELS + 1 },
            () => plainModel,
        );
        expect(() => new SystemPromptModule({ availableModels: tooManyModels })).toThrow(
            "System prompt available models are invalid",
        );

        const unicodeField = "😀".repeat(128);
        const unicodeCatalog = Array.from({ length: MAX_SYSTEM_PROMPT_AVAILABLE_MODELS }, () => ({
            name: unicodeField,
            id: unicodeField,
            providerId: unicodeField,
        }));
        expect(Value.Check(systemPromptAvailableModelsSchema, unicodeCatalog)).toBe(true);
        expect(() => new SystemPromptModule({ availableModels: unicodeCatalog })).toThrow(
            "System prompt available models exceed the configured UTF-8 byte bound",
        );
    });

    it("fits a maximal AGENTS.md chain into the remaining UTF-8 prompt budget", async () => {
        const compute = new FakeCompute("/workspace/packages/app");
        compute.directories.add("/workspace/.git");
        const document = "界".repeat(32_000);
        compute.write("/workspace/AGENTS_SECURITY.md", document);
        compute.write("/workspace/AGENTS.md", document);
        compute.write("/workspace/packages/AGENTS.md", document);
        compute.write("/workspace/packages/app/AGENTS.md", document);
        const module = new SystemPromptModule({
            availableModels: catalogWithBytes(MAX_SYSTEM_PROMPT_AVAILABLE_MODELS_BYTES - 1),
            compute: { resolve: async () => compute },
            globalInstructions: {
                path: "/home/agent/AGENTS.md",
                read: async () => "界".repeat(131_072),
            },
        });

        const prompt = await module.instructions(
            contextWithEnvironment(),
            scopeOf("anthropic/opus-5", "claude"),
        );

        expect(new TextEncoder().encode(prompt).byteLength).toBeLessThanOrEqual(
            MAX_SYSTEM_PROMPT_OUTPUT_BYTES,
        );
        expect(prompt).toContain("omitted to stay within the system prompt byte limit.");
    });

    it("enforces the combined prompt output byte bound after appending the environment", async () => {
        const environmentCtx = contextWithEnvironment({
            ...testEnvironment,
            osVersion: "x".repeat(MAX_SYSTEM_PROMPT_OUTPUT_BYTES),
        });

        await expect(
            new SystemPromptModule().instructions(
                environmentCtx,
                scopeOf("anthropic/opus-5", "claude"),
            ),
        ).rejects.toThrow("The system prompt exceeds the configured output bound");
    });

    it("detaches the injected model catalog and validates its bounded contract", async () => {
        const availableModels = [
            { name: "Claude Opus", id: "anthropic/opus-5", providerId: "anthropic" },
        ];
        const module = new SystemPromptModule({ availableModels });
        availableModels[0]!.name = "Mutated";

        const environmentCtx = contextWithEnvironment();
        const prompt = await module.instructions(
            environmentCtx,
            scopeOf("anthropic/opus-5", "claude"),
        );

        expect(prompt).toContain("- Claude Opus — model ID: `anthropic/opus-5`");
        expect(
            Value.Check(systemPromptAvailableModelSchema, {
                name: "Model",
                id: "model",
                providerId: "provider",
                unexpected: true,
            }),
        ).toBe(false);
        expect(
            Value.Check(systemPromptAvailableModelsSchema, [
                { name: "Model", id: "model", providerId: "provider" },
            ]),
        ).toBe(true);
        expect(
            Value.Check(systemPromptAvailableModelsSchema, [
                ...Array.from({ length: MAX_SYSTEM_PROMPT_AVAILABLE_MODELS + 1 }, () => ({
                    name: "Model",
                    id: "model",
                    providerId: "provider",
                })),
            ]),
        ).toBe(false);
        expect(
            () =>
                new SystemPromptModule({
                    availableModels: [{ name: "bad\nname", id: "id", providerId: "provider" }],
                }),
        ).toThrow("System prompt available models are invalid");
    });

    it("validates closed options and detaches the configured identity", async () => {
        const identity = { name: "Scout", prompt: "You are Scout, built by Happy" };
        const module = new SystemPromptModule({ identity });

        identity.name = "Mutated";
        identity.prompt = "A hostile replacement";

        expect(
            (await module.instructions(ctx, scopeOf("anthropic/opus-5", "claude"))).startsWith(
                "You are Scout, built by Happy",
            ),
        ).toBe(true);
        expect(
            Value.Check(systemPromptModuleOptionsSchema, {
                identity,
                unexpected: true,
            }),
        ).toBe(false);
        expect(
            Value.Check(systemPromptIdentitySchema, {
                name: "Scout",
                prompt: "{{identity}}",
            }),
        ).toBe(false);
        expect(
            Value.Check(systemPromptIdentitySchema, {
                name: "Scout\u0000",
                prompt: "You are Scout",
            }),
        ).toBe(false);
        expect(() => new SystemPromptModule({ unexpected: true } as never)).toThrow(
            "System prompt module options are invalid",
        );
        expect(
            () =>
                new SystemPromptModule({
                    compute: {
                        resolve: async () => undefined,
                        extra: true,
                    } as never,
                }),
        ).toThrow("System prompt module options are invalid");
        const inheritedIdentity = Object.create({
            name: "Inherited",
            prompt: "You are inherited",
        }) as { name: string; prompt: string };
        expect(() => new SystemPromptModule({ identity: inheritedIdentity })).toThrow(
            "System prompt identity is invalid",
        );
    });

    it("validates public model selection and keeps the selector provider-neutral", () => {
        expect(
            Value.Check(systemPromptSelectionSchema, {
                model: undefined,
                providerKind: "codex",
            }),
        ).toBe(true);
        expect(
            Value.Check(systemPromptSelectionSchema, {
                model: "x".repeat(257),
            }),
        ).toBe(false);
        expect(
            Value.Check(systemPromptSelectionSchema, {
                model: "openai/gpt-5.6-sol",
                extra: "not accepted",
            }),
        ).toBe(false);
        expect(() => systemPromptForModel({ providerKind: "not-a-provider" } as never)).toThrow(
            "System prompt model selection is invalid",
        );
        expect(() => systemPromptForModel({ model: "\u0000" } as never)).toThrow(
            "System prompt model selection is invalid",
        );
        expect(systemPromptForModel({ model: "__proto__" })).toContain(
            "You are an expert coding assistant.",
        );
    });
});
