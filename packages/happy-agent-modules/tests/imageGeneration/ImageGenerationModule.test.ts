import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

import { AgentKV, type AgentModuleScope, type AnyAgentTool } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    MAX_IMAGE_ID_CHARACTERS,
    imageAssetSchema,
    imageGenerationStatusSchema,
    type ImageGenerationInput,
    type ImageGenerationStatus,
} from "../../sources/imageGeneration/ImageGeneration.js";
import {
    ImageGenerationModule,
    imageGenerationModuleOptionsSchema,
    type ImageGenerationModuleOptions,
} from "../../sources/imageGeneration/ImageGenerationModule.js";
import {
    imageGenerationEventSchema,
    type ImageGenerationEvent,
} from "../../sources/imageGeneration/ImageGenerationEvent.js";
import type {
    GeneratedImage,
    ImageGenerator,
    ImageGeneratorRequest,
} from "../../sources/imageGeneration/ImageGenerator.js";
import { InMemoryPersistence } from "../support/InMemoryPersistence.js";

const root = createRootContext().named("image-generation-tests");
const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);

let outputRoot: string;

beforeEach(async () => {
    outputRoot = await mkdtemp(join(tmpdir(), "rig-image-generation-"));
});

afterEach(async () => {
    await rm(outputRoot, { force: true, recursive: true });
});

function generator(
    output: GeneratedImage = {
        bytes: PNG_BYTES,
        mediaType: "image/png",
        width: 32,
        height: 32,
        metadata: { provider: "test" },
    },
): { readonly generator: ImageGenerator; readonly generate: ReturnType<typeof vi.fn> } {
    const generate = vi.fn().mockResolvedValue(structuredClone(output));
    return { generator: { generate }, generate };
}

interface Harness {
    readonly module: ImageGenerationModule;
    readonly persistence: InMemoryPersistence;
    readonly tool: AnyAgentTool;
}

function harness(
    service: ImageGenerator,
    overrides: Partial<ImageGenerationModuleOptions> = {},
    persistence = new InMemoryPersistence(),
    agentId = "agent-1",
    agent: Partial<AgentModuleScope["agent"]> = {},
): Harness {
    const module = new ImageGenerationModule({
        generator: service,
        outputDirectory: outputRoot,
        idFactory: async () => "operation-1",
        eventIdFactory: async (_ctx, _agentId, operationId) => `event-${operationId}`,
        clock: () => 100,
        ...overrides,
    });
    const kv = new AgentKV(persistence, `kv.${agentId}.`).scoped("module", "image-generation");
    const tools = module.tools(root, {
        agent: {
            id: agentId,
            provider: "claude-primary",
            providerKind: "claude",
            ...agent,
        },
        kv,
    } as AgentModuleScope);
    const tool = tools[0];
    if (tool === undefined) throw new Error("Image generation tool is missing.");
    return { module, persistence, tool };
}

function completed(
    status: ImageGenerationStatus,
): asserts status is Extract<ImageGenerationStatus, { status: "completed" }> {
    expect(status.status).toBe("completed");
    if (status.status !== "completed") throw new Error("Expected completed image generation.");
}

function textFromTool(tool: AnyAgentTool, status: ImageGenerationStatus): string {
    const block = tool.toLLM(status)[0];
    if (block?.type !== "text") throw new Error("Expected a text tool result.");
    return block.text;
}

describe("ImageGenerationModule", () => {
    it("writes the generator bytes to a usable file inside the configured root", async () => {
        const generated = generator();
        const images = harness(generated.generator);
        const transaction = vi.spyOn(images.persistence, "transaction");
        const result = await images.module.generate(root, "agent-1", {
            operationId: "operation-file",
            prompt: "  A blue moon  ",
            options: { quality: "high" },
        });

        completed(result);
        const relativePath = relative(outputRoot, result.asset.locator);
        expect(isAbsolute(result.asset.locator)).toBe(true);
        expect(relativePath).not.toBe("");
        expect(relativePath.startsWith("..")).toBe(false);
        expect(isAbsolute(relativePath)).toBe(false);
        expect(result.asset.locator).toMatch(/\.png$/);
        expect(await readFile(result.asset.locator)).toEqual(Buffer.from(PNG_BYTES));
        expect((await stat(result.asset.locator)).isFile()).toBe(true);
        expect(result.asset.byteLength).toBe(PNG_BYTES.byteLength);
        expect(result.prompt).toBe("A blue moon");
        expect(await images.module.status(root, "agent-1", result.operationId)).toEqual(result);
        expect(await images.module.read(root, "agent-1", result.asset.id)).toEqual(result.asset);

        const request = generated.generate.mock.calls[0]?.[1] as ImageGeneratorRequest | undefined;
        expect(request).toMatchObject({
            agentId: "agent-1",
            operationId: "operation-file",
            prompt: "A blue moon",
            options: { quality: "high" },
        });
        expect(transaction).toHaveBeenCalledOnce();
    });

    it("uses the configured operation ID factory for direct host calls", async () => {
        const generated = generator();
        const images = harness(generated.generator);

        const result = await images.module.generate(root, "agent-1", {
            prompt: "A host-generated image",
        });

        expect(result.operationId).toBe("operation-1");
        expect(generated.generate).toHaveBeenCalledWith(
            root,
            expect.objectContaining({ operationId: "operation-1" }),
        );
    });

    it("rejects a duplicate operation ID from a fresh module", async () => {
        const firstGenerator = generator();
        const first = harness(firstGenerator.generator);
        const input: ImageGenerationInput = {
            operationId: "operation-conflict",
            prompt: "A lighthouse",
        };
        const created = await first.module.generate(root, "agent-1", input);
        completed(created);

        const conflictingGenerator = generator();
        const reloaded = harness(conflictingGenerator.generator, {}, first.persistence);
        await expect(reloaded.module.generate(root, "agent-1", input)).rejects.toThrow(
            "operation ID already exists",
        );

        expect(conflictingGenerator.generate).toHaveBeenCalledOnce();
        expect(await readdir(outputRoot)).toEqual([relative(outputRoot, created.asset.locator)]);
        expect(await readFile(created.asset.locator)).toEqual(Buffer.from(PNG_BYTES));
    });

    it("uses the call ID for non-durable imagegen and returns the real path", async () => {
        const generated = generator();
        const images = harness(generated.generator);
        const call = { id: "tool-call-1" } as never;

        const first = await images.tool.execute(root, { prompt: "  A tiny observatory  " }, call);

        completed(first);
        expect(first.operationId).toBe("tool-call-1");
        expect(generated.generate).toHaveBeenCalledOnce();
        expect(images.tool.name).toBe("imagegen");
        expect(images.tool.durable).toBe(false);
        expect(images.tool.requiresAutoOrFullAccess).toBe(true);
        expect(await images.tool.shouldReviewInAutoMode({ prompt: "A prompt" }, root)).toBe(true);
        expect(Value.Check(images.tool.returnType, first)).toBe(true);
        expect(
            Value.Check(images.tool.parameters, {
                prompt: "A prompt",
                operationId: "model-supplied",
            }),
        ).toBe(false);

        const modelText = textFromTool(images.tool, first);
        expect(modelText).toContain(`Operation ID: ${first.operationId}`);
        expect(modelText).toContain(`Asset ID: ${first.asset.id}`);
        expect(modelText).toContain(`Path: ${first.asset.locator}`);
        expect(modelText).not.toContain(PNG_BYTES.join(","));
        expect(await readFile(first.asset.locator)).toEqual(Buffer.from(PNG_BYTES));
        expect(generated.generate).toHaveBeenCalledWith(
            root,
            expect.objectContaining({ preferredProviderId: "claude-primary" }),
        );
    });

    it("uses Rig's Codex surface and forwards bounded edit selectors", async () => {
        const generated = generator();
        const images = harness(generated.generator, {}, new InMemoryPersistence(), "agent-1", {
            provider: "codex-primary",
            providerKind: "codex",
        });

        expect(images.tool.name).toBe("codex_imagegen");
        await images.tool.execute(
            root,
            {
                prompt: "Make the sky darker",
                referenced_image_paths: ["/tmp/reference.png"],
            },
            { id: "tool-call-edit" } as never,
        );

        expect(generated.generate).toHaveBeenCalledWith(
            root,
            expect.objectContaining({
                preferredProviderId: "codex-primary",
                referencedImagePaths: ["/tmp/reference.png"],
            }),
        );
        await expect(
            images.tool.execute(
                root,
                {
                    prompt: "Invalid selectors",
                    referenced_image_paths: ["/tmp/reference.png"],
                    num_last_images_to_include: 1,
                },
                { id: "tool-call-invalid" } as never,
            ),
        ).rejects.toThrow("only one");
    });

    it("records one failed outcome and rejects duplicate operation IDs", async () => {
        const transactional: ImageGenerationEvent[] = [];
        const postCommit: ImageGenerationEvent[] = [];
        const generate = vi.fn().mockRejectedValue(new Error("provider unavailable"));
        const images = harness(
            { generate },
            {
                listener: {
                    onEventTransactional: async (_ctx, event) => {
                        transactional.push(structuredClone(event));
                    },
                    onEvent: async (_ctx, event) => {
                        postCommit.push(structuredClone(event));
                    },
                },
            },
        );
        const transaction = vi.spyOn(images.persistence, "transaction");
        const input: ImageGenerationInput = {
            operationId: "operation-failed",
            prompt: "A storm over the ocean",
        };

        const failed = await images.module.generate(root, "agent-1", input);

        expect(failed).toMatchObject({
            status: "failed",
            operationId: "operation-failed",
            error: "provider unavailable",
        });
        expect(Value.Check(imageGenerationStatusSchema, failed)).toBe(true);
        expect(await images.module.status(root, "agent-1", "operation-failed")).toEqual(failed);
        expect(await readdir(outputRoot)).toEqual([]);
        expect(transactional).toHaveLength(1);
        expect(postCommit).toEqual(transactional);
        expect(Value.Check(imageGenerationEventSchema, transactional[0])).toBe(true);
        expect(transactional[0]).toMatchObject({
            type: "image_generation_changed",
            operation: failed,
        });
        expect(textFromTool(images.tool, failed)).toContain("Image generation failed.");
        expect(textFromTool(images.tool, failed)).toContain("Error: provider unavailable");
        expect(transaction).toHaveBeenCalledOnce();

        await expect(images.module.generate(root, "agent-1", input)).rejects.toThrow(
            "operation ID already exists",
        );
        expect(generate).toHaveBeenCalledTimes(2);
        expect(transactional).toHaveLength(1);
        expect(postCommit).toHaveLength(1);
        expect(transaction).toHaveBeenCalledTimes(2);
    });

    it("emits schema-valid completion and removal events around durable state changes", async () => {
        const transactional: ImageGenerationEvent[] = [];
        const postCommit: ImageGenerationEvent[] = [];
        const images = harness(generator().generator, {
            listener: {
                onEventTransactional: async (_ctx, event) => {
                    transactional.push(structuredClone(event));
                },
                onEvent: async (_ctx, event) => {
                    postCommit.push(structuredClone(event));
                },
            },
        });
        const created = await images.module.generate(root, "agent-1", {
            operationId: "operation-events",
            prompt: "A paper kite",
        });
        completed(created);

        expect(transactional).toHaveLength(1);
        expect(postCommit).toEqual(transactional);
        expect(transactional[0]).toMatchObject({
            type: "image_generation_changed",
            agentId: "agent-1",
            operationId: created.operationId,
            operation: created,
        });
        expect(Value.Check(imageGenerationEventSchema, transactional[0])).toBe(true);

        await expect(images.module.remove(root, "agent-1", created.asset.id)).resolves.toBe(true);
        expect(transactional).toHaveLength(2);
        expect(postCommit).toEqual(transactional);
        expect(transactional[1]).toMatchObject({
            type: "image_removed",
            agentId: "agent-1",
            assetId: created.asset.id,
        });
        expect(Value.Check(imageGenerationEventSchema, transactional[1])).toBe(true);
        expect(await images.module.status(root, "agent-1", created.operationId)).toBeUndefined();
        expect(await images.module.read(root, "agent-1", created.asset.id)).toBeUndefined();
        await expect(stat(created.asset.locator)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readdir(outputRoot)).toEqual([]);
        await expect(images.module.remove(root, "agent-1", created.asset.id)).resolves.toBe(false);
        expect(transactional).toHaveLength(2);
    });

    it("removes a published file when the durable transaction fails", async () => {
        const images = harness(generator().generator, {
            listener: {
                onEventTransactional: async () => {
                    throw new Error("transactional listener failed");
                },
            },
        });

        await expect(
            images.module.generate(root, "agent-1", {
                operationId: "operation-rollback",
                prompt: "A vanishing image",
            }),
        ).rejects.toThrow("transactional listener failed");
        expect(await readdir(outputRoot)).toEqual([]);
        expect(await images.module.status(root, "agent-1", "operation-rollback")).toBeUndefined();
    });

    it("enforces input, generator-output, byte, and model-output bounds", async () => {
        const generated = generator();
        const images = harness(generated.generator);

        await expect(
            images.module.generate(root, "agent-1", {
                operationId: "operation-long-prompt",
                prompt: "x".repeat(8_001),
            }),
        ).rejects.toThrow("input is invalid");
        await expect(
            images.module.generate(root, "agent-1", {
                operationId: "operation-long-style",
                prompt: "Valid prompt",
                options: { style: "x".repeat(513) },
            }),
        ).rejects.toThrow("input is invalid");
        expect(generated.generate).not.toHaveBeenCalled();

        const oversized = harness(
            generator({ bytes: new Uint8Array([1, 2, 3, 4]), mediaType: "image/png" }).generator,
            { maxOutputBytes: 3 },
            new InMemoryPersistence(),
            "agent-oversized",
        );
        const oversizedResult = await oversized.module.generate(root, "agent-oversized", {
            operationId: "operation-oversized",
            prompt: "Too many bytes",
        });
        expect(oversizedResult).toMatchObject({ status: "failed" });
        if (oversizedResult.status === "failed") {
            expect(oversizedResult.error).toContain("byte limit");
        }

        const malformed = harness(
            generator({
                bytes: new Uint8Array([1]),
                mediaType: "not-an-image",
            } as never).generator,
            {},
            new InMemoryPersistence(),
            "agent-malformed",
        );
        const malformedResult = await malformed.module.generate(root, "agent-malformed", {
            operationId: "operation-malformed",
            prompt: "Malformed output",
        });
        expect(malformedResult).toMatchObject({
            status: "failed",
            error: "Image generator returned invalid image data.",
        });
        expect(await readdir(outputRoot)).toEqual([]);

        expect(
            () =>
                new ImageGenerationModule({
                    generator: generated.generator,
                    outputDirectory: outputRoot,
                    maxOutputBytes: 0,
                }),
        ).toThrow("options are invalid");
        expect(
            Value.Check(imageGenerationModuleOptionsSchema, {
                generator: generated.generator,
                outputDirectory: outputRoot,
                unexpected: true,
            }),
        ).toBe(false);
        expect(Value.Check(imageAssetSchema, { id: "only-id" })).toBe(false);
        expect(Value.Check(imageGenerationStatusSchema, { status: "completed" })).toBe(false);
    });

    it("passes normalized input to the generator and rejects operation ID reuse", async () => {
        const generated = generator();
        const images = harness(generated.generator);
        const operationId = "operation-conflict";
        const created = await images.module.generate(root, "agent-1", {
            operationId,
            prompt: "  A mountain  ",
            options: { style: "ink" },
        });
        const request = generated.generate.mock.calls[0]?.[1] as ImageGeneratorRequest | undefined;

        expect(request).toEqual({
            agentId: "agent-1",
            operationId,
            options: { style: "ink" },
            prompt: "A mountain",
        });
        await expect(
            images.module.generate(root, "agent-1", {
                operationId,
                prompt: "A different mountain",
            }),
        ).rejects.toThrow("operation ID already exists");
        expect(generated.generate).toHaveBeenCalledTimes(2);
        completed(created);
        expect(await readFile(created.asset.locator)).toEqual(Buffer.from(PNG_BYTES));
    });

    it("keeps model rendering bounded while retaining actionable identities", async () => {
        const images = harness(generator().generator);
        const result = await images.module.generate(root, "agent-1", {
            operationId: "o".repeat(MAX_IMAGE_ID_CHARACTERS),
            prompt: "A prompt whose optional rendering can be dropped",
        });
        completed(result);

        const output = images.module.formatForModel(result, 512);
        expect(output.length).toBeLessThanOrEqual(512);
        expect(output).toContain(result.operationId);
        expect(output).toContain(result.asset.id);
        expect(output).toContain(result.asset.mediaType);
        expect(output).toContain(result.asset.locator);
        expect(() => images.module.formatForModel(result, 255)).toThrow(
            "character bound is invalid",
        );
    });
});
