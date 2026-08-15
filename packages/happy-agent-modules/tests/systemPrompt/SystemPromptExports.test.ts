import * as root from "../../sources/index.js";
import {
    systemPromptModuleOptionsSchema,
    systemPromptIdentitySchema,
    systemPromptSelectionSchema,
} from "../../sources/systemPrompt/SystemPromptModule.js";
import { systemPromptProviderKindSchema } from "../../sources/systemPrompt/SystemPromptSelection.js";
import { describe, expect, it } from "vitest";

describe("System Prompt package exports", () => {
    it("exposes the same runtime contracts from the package root", () => {
        expect(root.systemPromptModuleOptionsSchema).toBe(systemPromptModuleOptionsSchema);
        expect(root.systemPromptIdentitySchema).toBe(systemPromptIdentitySchema);
        expect(root.systemPromptSelectionSchema).toBe(systemPromptSelectionSchema);
        expect(root.systemPromptProviderKindSchema).toBe(systemPromptProviderKindSchema);
        expect(root.SystemPromptModule).toBeDefined();
        expect(root.systemPromptForModel).toBeDefined();
    });
});
