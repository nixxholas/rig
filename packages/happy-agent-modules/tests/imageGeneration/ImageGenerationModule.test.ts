import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

import { AgentKV, type AgentModuleScope, type AnyAgentTool } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { createRootContext, withAfterCommit } from "@steve.kite/stdlib";
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
import { resolveModuleHooks } from "../support/moduleHooks.js";

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

async function harness(
    service: ImageGenerator,
    overrides: Partial<ImageGenerationModuleOptions> = {},
    persistence = new InMemoryPersistence(),
    agentId = "agent-1",
    agent: Partial<AgentModuleScope["agent"]> = {},
): Promise<Harness> {
    const module = new ImageGenerationModule({
        generator: service,
        outputDirectory: outputRoot,
        idFactory: async () => "operation-1",
        eventIdFactory: async (_ctx, _agentId, operationId) => `event-${operationId}`,
        clock: () => 100,
        ...overrides,
    });
    const kv = new AgentKV(persistence, `kv.${agentId}.`).scoped("module", "image-generation");
    const hooks = await resolveModuleHooks(root, module);
    const tools = await hooks.tools!(root, {
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

function catalogKey(agentId: string, key: string): string {
    return `kv.${agentId}.module.image-generation.catalog.${key}`;
}

function seedCatalog(
    persistence: InMemoryPersistence,
    agentId: string,
    key: string,
    value: unknown,
): void {
    persistence.values.set(catalogKey(agentId, key), structuredClone(value));
}

describe("ImageGenerationModule", () => {
    it("writes the generator bytes to a usable file inside the configured root", async () => {
        const generated = generator();
        const images = await harness(generated.generator);
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
        const images = await harness(generated.generator);

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
        const first = await harness(firstGenerator.generator);
        const input: ImageGenerationInput = {
            operationId: "operation-conflict",
            prompt: "A lighthouse",
        };
        const created = await first.module.generate(root, "agent-1", input);
        completed(created);

        const conflictingGenerator = generator();
        const reloaded = await harness(conflictingGenerator.generator, {}, first.persistence);
        await expect(reloaded.module.generate(root, "agent-1", input)).rejects.toThrow(
            "operation ID already exists",
        );

        expect(conflictingGenerator.generate).toHaveBeenCalledOnce();
        expect(await readdir(outputRoot)).toEqual([relative(outputRoot, created.asset.locator)]);
        expect(await readFile(created.asset.locator)).toEqual(Buffer.from(PNG_BYTES));
    });

    it("uses the call ID for non-durable imagegen and returns the real path", async () => {
        const generated = generator();
        const images = await harness(generated.generator);
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
        const images = await harness(
            generated.generator,
            {},
            new InMemoryPersistence(),
            "agent-1",
            {
                provider: "codex-primary",
                providerKind: "codex",
            },
        );

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
        const images = await harness(
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
        const images = await harness(generator().generator, {
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
        const images = await harness(generator().generator, {
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
        const images = await harness(generated.generator);

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

        const oversized = await harness(
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

        const malformed = await harness(
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
        const images = await harness(generated.generator);
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
        const images = await harness(generator().generator);
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

    it("rejects whitespace-only prompts and unsafe reference paths before calling the generator", async () => {
        const generated = generator();
        const images = await harness(generated.generator);

        await expect(
            images.module.generate(root, "agent-1", {
                operationId: "operation-whitespace",
                prompt: " \t\n ",
            }),
        ).rejects.toThrow("prompt");
        await expect(
            images.module.generate(root, "agent-1", {
                operationId: "operation-reference-control",
                prompt: "An edit",
                referencedImagePaths: ["reference\nimage.png"],
            }),
        ).rejects.toThrow("input is invalid");
        await expect(
            images.module.generate(root, "agent-1", {
                operationId: "operation-reference-null",
                prompt: "An edit",
                referencedImagePaths: [String.fromCharCode(0) + "reference.png"],
            }),
        ).rejects.toThrow("input is invalid");
        expect(generated.generate).not.toHaveBeenCalled();
    });

    it("rejects relative and control-character output directories", () => {
        const generated = generator();

        expect(
            () =>
                new ImageGenerationModule({
                    generator: generated.generator,
                    outputDirectory: "relative/generated",
                }),
        ).toThrow("options are invalid");
        expect(
            () =>
                new ImageGenerationModule({
                    generator: generated.generator,
                    outputDirectory: "generated\nfolder",
                }),
        ).toThrow("options are invalid");
    });

    it("classifies synchronous, malformed, and hostile generator results as bounded failures", async () => {
        const synchronous = await harness({
            generate: (() => ({
                bytes: PNG_BYTES,
                mediaType: "image/png",
            })) as never,
        });
        const syncResult = await synchronous.module.generate(root, "agent-1", {
            operationId: "operation-sync-generator",
            prompt: "Synchronous provider result",
        });
        expect(syncResult).toMatchObject({
            status: "failed",
            error: expect.stringContaining("must return a Promise"),
        });

        const malformed = await harness({
            generate: vi.fn().mockResolvedValue({
                bytes: PNG_BYTES,
                mediaType: "image/png",
                unexpected: true,
            }),
        } as never);
        const malformedResult = await malformed.module.generate(root, "agent-1", {
            operationId: "operation-extra-result-key",
            prompt: "Extra provider result key",
        });
        expect(malformedResult).toMatchObject({
            status: "failed",
            error: "Image generator returned invalid image data.",
        });

        const hostile = {
            [Symbol.toPrimitive](): never {
                throw new Error("toString trap");
            },
        };
        const rejected = await harness({
            generate: vi.fn().mockRejectedValue(hostile),
        } as never);
        const rejectedResult = await rejected.module.generate(root, "agent-1", {
            operationId: "operation-hostile-error",
            prompt: "Hostile provider error",
        });
        expect(rejectedResult).toMatchObject({
            status: "failed",
            error: "Unknown image generation error.",
        });

        const oversizedError = await harness({
            generate: vi.fn().mockRejectedValue(new Error("x".repeat(3_000))),
        } as never);
        const oversizedResult = await oversizedError.module.generate(root, "agent-1", {
            operationId: "operation-long-error",
            prompt: "Long provider error",
        });
        expect(oversizedResult.status).toBe("failed");
        if (oversizedResult.status === "failed") {
            expect(oversizedResult.error).toHaveLength(2_000);
        }
    });

    it("contains thenable traps and rejects hostile generated metadata", async () => {
        const thenable = {
            get then(): never {
                throw new Error("then getter failed");
            },
        };
        const trapped = await harness({
            generate: vi.fn().mockReturnValue(thenable),
        } as never);
        const trappedResult = await trapped.module.generate(root, "agent-1", {
            operationId: "operation-then-trap",
            prompt: "Thenable trap",
        });
        expect(trappedResult).toMatchObject({
            status: "failed",
            error: "then getter failed",
        });

        const invalidMetadata = await harness(
            generator({
                bytes: PNG_BYTES,
                mediaType: "image/png",
                metadata: { notFinite: Number.NaN },
            } as never).generator,
        );
        const invalidMetadataResult = await invalidMetadata.module.generate(root, "agent-1", {
            operationId: "operation-nan-metadata",
            prompt: "NaN metadata",
        });
        expect(invalidMetadataResult).toMatchObject({
            status: "failed",
            error: "Image generator returned invalid image data.",
        });

        const tooManyProperties = Object.fromEntries(
            Array.from({ length: 33 }, (_, index) => [`property-${String(index)}`, true]),
        );
        const manyProperties = await harness(
            generator({
                bytes: PNG_BYTES,
                mediaType: "image/png",
                metadata: tooManyProperties,
            } as never).generator,
        );
        const manyPropertiesResult = await manyProperties.module.generate(root, "agent-1", {
            operationId: "operation-many-metadata-properties",
            prompt: "Too many metadata properties",
        });
        expect(manyPropertiesResult).toMatchObject({
            status: "failed",
            error: "Image generator returned invalid image data.",
        });

        const oversizedMetadata = Object.fromEntries(
            Array.from({ length: 32 }, (_, index) => [
                `property-${String(index)}`,
                "x".repeat(1_024),
            ]),
        );
        const hugeMetadata = await harness(
            generator({
                bytes: PNG_BYTES,
                mediaType: "image/png",
                metadata: oversizedMetadata,
            } as never).generator,
        );
        const hugeMetadataResult = await hugeMetadata.module.generate(root, "agent-1", {
            operationId: "operation-huge-metadata",
            prompt: "Huge metadata",
        });
        expect(hugeMetadataResult).toMatchObject({
            status: "failed",
            error: "Image generator metadata exceeds the configured bound.",
        });
    });

    it("preserves class-backed generator receiver state", async () => {
        class StatefulGenerator {
            calls = 0;

            async generate(
                _ctx: Parameters<ImageGenerator["generate"]>[0],
                _request: Parameters<ImageGenerator["generate"]>[1],
            ): Promise<GeneratedImage> {
                this.calls += 1;
                return {
                    bytes: PNG_BYTES,
                    mediaType: "image/png",
                };
            }
        }

        const service = new StatefulGenerator();
        const images = await harness(service as unknown as ImageGenerator);
        await images.module.generate(root, "agent-1", {
            operationId: "operation-class-generator",
            prompt: "Class-backed provider",
        });
        expect(service.calls).toBe(1);
    });

    it("selects the Codex surface for Bedrock OpenAI models", async () => {
        const images = await harness(
            generator().generator,
            {},
            new InMemoryPersistence(),
            "agent-1",
            {
                provider: "bedrock-openai",
                providerKind: "bedrock",
                model: "openai/gpt-5-6",
            },
        );
        expect(images.tool.name).toBe("codex_imagegen");
    });

    it("rejects malformed operation records and ownership mismatches after a restart", async () => {
        const malformedPersistence = new InMemoryPersistence();
        const malformed = await harness(generator().generator, {}, malformedPersistence, "agent-1");
        seedCatalog(malformedPersistence, "agent-1", "operation.malformed", {
            status: "completed",
        });
        await expect(malformed.module.status(root, "agent-1", "malformed")).rejects.toThrow(
            "catalog entry is corrupt",
        );

        const ownershipPersistence = new InMemoryPersistence();
        const ownership = await harness(generator().generator, {}, ownershipPersistence, "agent-1");
        seedCatalog(ownershipPersistence, "agent-1", "operation.cross-agent", {
            agentId: "agent-2",
            operationId: "cross-agent",
            prompt: "Stored under the wrong agent",
            status: "completed",
            createdAt: 1,
            updatedAt: 1,
            asset: {
                id: "asset-cross-agent",
                agentId: "agent-2",
                operationId: "cross-agent",
                mediaType: "image/png",
                byteLength: 1,
                locator: join(outputRoot, "cross-agent.png"),
            },
        });
        await expect(ownership.module.status(root, "agent-1", "cross-agent")).rejects.toThrow(
            "catalog entry is corrupt",
        );
    });

    it("rejects dangling and mismatched asset indexes instead of hiding corruption", async () => {
        const danglingPersistence = new InMemoryPersistence();
        const dangling = await harness(generator().generator, {}, danglingPersistence, "agent-1");
        seedCatalog(danglingPersistence, "agent-1", "asset.dangling", "missing-operation");
        await expect(dangling.module.read(root, "agent-1", "dangling")).rejects.toThrow("catalog");

        const mismatchedPersistence = new InMemoryPersistence();
        const mismatched = await harness(
            generator().generator,
            {},
            mismatchedPersistence,
            "agent-1",
        );
        seedCatalog(mismatchedPersistence, "agent-1", "asset.mismatched", "operation-mismatched");
        seedCatalog(mismatchedPersistence, "agent-1", "operation.operation-mismatched", {
            agentId: "agent-1",
            operationId: "operation-mismatched",
            prompt: "Mismatched asset index",
            status: "completed",
            createdAt: 1,
            updatedAt: 1,
            asset: {
                id: "different-asset",
                agentId: "agent-1",
                operationId: "operation-mismatched",
                mediaType: "image/png",
                byteLength: 1,
                locator: join(outputRoot, "mismatched.png"),
            },
        });
        await expect(mismatched.module.read(root, "agent-1", "mismatched")).rejects.toThrow(
            "catalog",
        );
    });

    it("never deletes a file outside its configured output directory from corrupt state", async () => {
        const externalDirectory = await mkdtemp(join(tmpdir(), "rig-image-external-"));
        const externalFile = join(externalDirectory, "sentinel.png");
        await writeFile(externalFile, Buffer.from("must-survive"));
        try {
            const persistence = new InMemoryPersistence();
            const images = await harness(generator().generator, {}, persistence, "agent-1");
            seedCatalog(persistence, "agent-1", "operation.external-path", {
                agentId: "agent-1",
                operationId: "external-path",
                prompt: "External locator",
                status: "completed",
                createdAt: 1,
                updatedAt: 1,
                asset: {
                    id: "asset-external-path",
                    agentId: "agent-1",
                    operationId: "external-path",
                    mediaType: "image/png",
                    byteLength: 1,
                    locator: externalFile,
                },
            });
            seedCatalog(persistence, "agent-1", "asset.asset-external-path", "external-path");

            await expect(
                images.module.remove(root, "agent-1", "asset-external-path"),
            ).rejects.toThrow("catalog");
            expect(await readFile(externalFile)).toEqual(Buffer.from("must-survive"));
        } finally {
            await rm(externalDirectory, { force: true, recursive: true });
        }
    });

    it("uses an absolute locator when a host supplies a relative output directory", async () => {
        const images = await harness(generator().generator, {
            outputDirectory: relative(process.cwd(), outputRoot),
        });
        const result = await images.module.generate(root, "agent-1", {
            operationId: "operation-relative-output",
            prompt: "Relative output directory",
        });
        completed(result);
        expect(isAbsolute(result.asset.locator)).toBe(true);
        expect(relative(outputRoot, result.asset.locator).startsWith("..")).toBe(false);
    });

    it("records a failed operation when the output filesystem cannot be written", async () => {
        const blockedDirectory = join(outputRoot, "blocked-output");
        await writeFile(blockedDirectory, Buffer.from("not a directory"));
        const images = await harness(generator().generator, {
            outputDirectory: blockedDirectory,
        });

        const result = await images.module.generate(root, "agent-1", {
            operationId: "operation-filesystem-failure",
            prompt: "Blocked output directory",
        });
        expect(result).toMatchObject({
            status: "failed",
            operationId: "operation-filesystem-failure",
        });
        expect(await images.module.status(root, "agent-1", "operation-filesystem-failure")).toEqual(
            result,
        );
    });

    it("does not overwrite an existing asset when UUID allocation collides", async () => {
        const randomUUID = vi.spyOn(globalThis.crypto, "randomUUID");
        const sequence = ["asset-collision", "temp-first", "asset-collision", "temp-second"];
        randomUUID.mockImplementation(
            () =>
                (sequence.shift() ?? "fallback-id") as ReturnType<
                    typeof globalThis.crypto.randomUUID
                >,
        );
        try {
            const generated = generator();
            const images = await harness(generated.generator);
            const first = await images.module.generate(root, "agent-1", {
                operationId: "operation-first-asset",
                prompt: "First image",
            });
            completed(first);
            await expect(
                images.module.generate(root, "agent-1", {
                    operationId: "operation-second-asset",
                    prompt: "Second image",
                }),
            ).rejects.toThrow();
            expect(await readFile(first.asset.locator)).toEqual(Buffer.from(PNG_BYTES));
            expect(await images.module.status(root, "agent-1", "operation-first-asset")).toEqual(
                first,
            );
            expect(await images.module.status(root, "agent-1", "operation-second-asset")).toBe(
                undefined,
            );
        } finally {
            randomUUID.mockRestore();
        }
    });

    it("deep-freezes one event for both listeners", async () => {
        let transactionalEvent: ImageGenerationEvent | undefined;
        let postCommitEvent: ImageGenerationEvent | undefined;
        const images = await harness(generator().generator, {
            listener: {
                onEventTransactional: async (_ctx, event) => {
                    transactionalEvent = event;
                    if (!Object.isFrozen(event)) {
                        if (event.type === "image_generation_changed") {
                            (
                                event.operation as unknown as {
                                    prompt: string;
                                }
                            ).prompt = "mutated by listener";
                        }
                    }
                },
                onEvent: async (_ctx, event) => {
                    postCommitEvent = event;
                },
            },
        });
        const result = await images.module.generate(root, "agent-1", {
            operationId: "operation-frozen-event",
            prompt: "Immutable event prompt",
        });
        completed(result);

        expect(transactionalEvent).toBeDefined();
        expect(postCommitEvent).toBeDefined();
        expect(Object.isFrozen(transactionalEvent)).toBe(true);
        expect(Object.isFrozen(postCommitEvent)).toBe(true);
        if (
            transactionalEvent?.type === "image_generation_changed" &&
            postCommitEvent?.type === "image_generation_changed"
        ) {
            expect(Object.isFrozen(transactionalEvent.operation)).toBe(true);
            expect(Object.isFrozen(postCommitEvent.operation)).toBe(true);
            expect(postCommitEvent.operation.prompt).toBe("Immutable event prompt");
        }
    });

    it("defers post-commit delivery until an outer afterCommit scope drains", async () => {
        const postCommit: ImageGenerationEvent[] = [];
        const images = await harness(generator().generator, {
            listener: {
                onEvent: async (_ctx, event) => {
                    postCommit.push(event);
                },
            },
        });
        const [outerCtx, drain] = withAfterCommit(root);
        await images.module.generate(outerCtx, "agent-1", {
            operationId: "operation-outer-commit",
            prompt: "Outer transaction event",
        });
        expect(postCommit).toHaveLength(0);
        await drain();
        expect(postCommit).toHaveLength(1);
    });

    it("contains post-commit listener failures and reports hostile errors safely", async () => {
        const report = vi.fn().mockResolvedValue(undefined);
        const hostile = {
            [Symbol.toPrimitive](): never {
                throw new Error("observer conversion trap");
            },
        };
        const images = await harness(generator().generator, {
            listener: {
                onEvent: async () => {
                    throw hostile;
                },
            },
            onPostCommitError: report,
        });

        const result = await images.module.generate(root, "agent-1", {
            operationId: "operation-post-commit-failure",
            prompt: "Post-commit failure",
        });
        completed(result);
        expect(await images.module.status(root, "agent-1", result.operationId)).toEqual(result);
        expect(report).toHaveBeenCalledOnce();
        expect(report.mock.calls[0]?.[2]).toBe("Unknown image observer error.");
    });

    it("rolls back removal when its transactional listener fails", async () => {
        const images = await harness(generator().generator, {
            listener: {
                onEventTransactional: async (_ctx, event) => {
                    if (event.type === "image_removed") {
                        throw new Error("remove listener failed");
                    }
                },
            },
        });
        const created = await images.module.generate(root, "agent-1", {
            operationId: "operation-remove-rollback",
            prompt: "Keep this image",
        });
        completed(created);

        await expect(images.module.remove(root, "agent-1", created.asset.id)).rejects.toThrow(
            "remove listener failed",
        );
        expect(await images.module.status(root, "agent-1", created.operationId)).toEqual(created);
        expect(await images.module.read(root, "agent-1", created.asset.id)).toEqual(created.asset);
        expect(await readFile(created.asset.locator)).toEqual(Buffer.from(PNG_BYTES));
    });

    it("rolls back files and catalog writes when factories return invalid values", async () => {
        const invalidOperationGenerator = generator();
        const invalidOperation = await harness(invalidOperationGenerator.generator, {
            idFactory: async () => "operation\ninvalid",
        });
        await expect(
            invalidOperation.module.generate(root, "agent-1", {
                prompt: "Invalid operation factory value",
            }),
        ).rejects.toThrow("operation ID is invalid");
        expect(invalidOperationGenerator.generate).not.toHaveBeenCalled();

        const invalidEvent = await harness(generator().generator, {
            eventIdFactory: async () => "",
        });
        await expect(
            invalidEvent.module.generate(root, "agent-1", {
                operationId: "operation-invalid-event",
                prompt: "Invalid event factory value",
            }),
        ).rejects.toThrow("event ID factory returned an invalid ID");
        expect(await readdir(outputRoot)).toEqual([]);
        expect(
            await invalidEvent.module.status(root, "agent-1", "operation-invalid-event"),
        ).toBeUndefined();

        const invalidClock = await harness(generator().generator, {
            clock: () => -1,
        });
        await expect(
            invalidClock.module.generate(root, "agent-1", {
                operationId: "operation-invalid-clock",
                prompt: "Invalid clock value",
            }),
        ).rejects.toThrow("clock returned an invalid timestamp");
        expect(await readdir(outputRoot)).toEqual([]);
    });

    it("rejects malformed asset indexes and keeps status/read results detached", async () => {
        const malformedPersistence = new InMemoryPersistence();
        const malformed = await harness(generator().generator, {}, malformedPersistence, "agent-1");
        seedCatalog(malformedPersistence, "agent-1", "asset.bad-index", {
            operationId: "operation",
        });
        await expect(malformed.module.read(root, "agent-1", "bad-index")).rejects.toThrow(
            "asset index is corrupt",
        );

        const images = await harness(generator().generator);
        const created = await images.module.generate(root, "agent-1", {
            operationId: "operation-detached-result",
            prompt: "Detached result",
        });
        completed(created);
        const returned = await images.module.status(root, "agent-1", created.operationId);
        if (returned?.status === "completed") {
            returned.asset.metadata = { provider: "mutated-after-read" };
        }
        expect(await images.module.status(root, "agent-1", created.operationId)).toEqual(created);
    });

    it("rejects unknown keys on class-backed injected contracts", () => {
        class GeneratorWithExtraKey {
            readonly unexpected = true;

            async generate(): Promise<GeneratedImage> {
                return {
                    bytes: PNG_BYTES,
                    mediaType: "image/png",
                };
            }
        }
        expect(
            () =>
                new ImageGenerationModule({
                    generator: new GeneratorWithExtraKey() as unknown as ImageGenerator,
                    outputDirectory: outputRoot,
                }),
        ).toThrow("options are invalid");

        class ListenerWithExtraKey {
            readonly unexpected = true;

            async onEvent(): Promise<void> {}
        }
        expect(
            () =>
                new ImageGenerationModule({
                    generator: generator().generator,
                    outputDirectory: outputRoot,
                    listener: new ListenerWithExtraKey() as unknown as NonNullable<
                        ImageGenerationModuleOptions["listener"]
                    >,
                }),
        ).toThrow("options are invalid");
    });
});
