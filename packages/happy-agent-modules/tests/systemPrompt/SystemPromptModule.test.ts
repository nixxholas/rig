import type { AgentModuleAgent, AgentModuleScope } from "@slopus/happy-agent-base";
import type { ProviderModelCompatibilityType } from "@slopus/happy-providers";
import { Value } from "@sinclair/typebox/value";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    SystemPromptModule,
    systemPromptModuleOptionsSchema,
    systemPromptSelectionSchema,
} from "../../sources/systemPrompt/SystemPromptModule.js";
import { systemPromptIdentitySchema } from "../../sources/systemPrompt/SystemPromptIdentity.js";
import { systemPromptForModel } from "../../sources/systemPrompt/impl/systemPromptForModel.js";

const ctx: Context = createRootContext();

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

describe("SystemPromptModule", () => {
    it("gives each model the prompt it was written for", () => {
        const module = new SystemPromptModule();

        const opus5 = module.instructions(ctx, scopeOf("anthropic/opus-5", "claude"));
        const opus48 = module.instructions(ctx, scopeOf("anthropic/opus-4-8", "claude"));
        const codex = module.instructions(ctx, scopeOf("openai/gpt-5.6-sol", "codex"));

        expect(opus5).toContain("mid-conversation system turns");
        expect(opus48).not.toContain("mid-conversation system turns");
        expect(opus5).not.toBe(opus48);
        expect(codex).not.toBe(opus5);
        expect(codex.length).toBeGreaterThan(0);
    });

    it("follows the model rather than the provider it is served through", () => {
        const module = new SystemPromptModule();

        expect(module.instructions(ctx, scopeOf("anthropic/opus-5", "bedrock"))).toBe(
            module.instructions(ctx, scopeOf("anthropic/opus-5", "claude")),
        );
        expect(module.instructions(ctx, scopeOf("xai/grok-build", "grok"))).toBe(
            module.instructions(ctx, scopeOf("xai/grok-4.5", "grok")),
        );
    });

    it("falls back to the provider's family when the model is unknown or absent", () => {
        const module = new SystemPromptModule();

        expect(module.instructions(ctx, scopeOf("openai/gpt-9-unreleased", "codex"))).toBe(
            module.instructions(ctx, scopeOf("openai/gpt-5.6-sol", "codex")),
        );
        expect(module.instructions(ctx, scopeOf(undefined, "grok"))).toBe(
            module.instructions(ctx, scopeOf("xai/grok-4.5", "grok")),
        );
    });

    it("falls back to the simple prompt when nothing was written for the model", () => {
        const module = new SystemPromptModule();

        const unknown = module.instructions(ctx, scopeOf("mystery/model", "gym"));

        expect(unknown).toContain("You are an expert coding assistant.");
        expect(unknown.startsWith("You are Rig, built by Happy")).toBe(true);
        expect(module.instructions(ctx, scopeOf(undefined, undefined))).toBe(unknown);
    });

    it("substitutes the identity it was built with", () => {
        const named = new SystemPromptModule({
            identity: { name: "Scout", prompt: "You are Scout, built by Happy" },
        });

        const claudePrompt = named.instructions(ctx, scopeOf("anthropic/opus-5", "claude"));
        const codexPrompt = named.instructions(ctx, scopeOf("openai/gpt-5.6-sol", "codex"));

        for (const prompt of [claudePrompt, codexPrompt]) {
            expect(prompt.startsWith("You are Scout, built by Happy")).toBe(true);
            expect(prompt).not.toContain("{{identity}}");
            expect(prompt).not.toContain("{{name}}");
        }
        expect(codexPrompt).toContain("As Scout,");
    });

    it("substitutes replacement-string metacharacters literally", () => {
        for (const value of ["$&", "$`", "$'"]) {
            const prompt = new SystemPromptModule({
                identity: { name: value, prompt: value },
            }).instructions(ctx, scopeOf("anthropic/opus-5", "claude"));

            expect(prompt.startsWith(value)).toBe(true);
            expect(prompt).toContain(value);
            expect(prompt).not.toContain("{{identity}}");
            expect(prompt).not.toContain("{{name}}");
        }
    });

    it("names Rig when the host names nobody", () => {
        const module = new SystemPromptModule();
        const claudePrompt = module.instructions(ctx, scopeOf("anthropic/opus-5", "claude"));
        const codexPrompt = module.instructions(ctx, scopeOf("openai/gpt-5.6-sol", "codex"));

        expect(claudePrompt.startsWith("You are Rig, built by Happy")).toBe(true);
        expect(codexPrompt.startsWith("You are Rig, built by Happy")).toBe(true);
        expect(codexPrompt).toContain("As Rig,");
    });

    it("validates closed options and detaches the configured identity", () => {
        const identity = { name: "Scout", prompt: "You are Scout, built by Happy" };
        const module = new SystemPromptModule({ identity });

        identity.name = "Mutated";
        identity.prompt = "A hostile replacement";

        expect(
            module
                .instructions(ctx, scopeOf("anthropic/opus-5", "claude"))
                .startsWith("You are Scout, built by Happy"),
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
        const inheritedIdentity = Object.create({
            name: "Inherited",
            prompt: "You are inherited",
        }) as { name: string; prompt: string };
        expect(() => new SystemPromptModule({ identity: inheritedIdentity })).toThrow(
            "System prompt module options are invalid",
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
