import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    MAX_IMAGE_OPERATION_CANONICAL_BYTES,
    MAX_IMAGE_OPERATION_CANONICAL_DEPTH,
    generatedImageSchema,
    imageAssetSchema,
    imageGenerationModuleOptionsSchema,
    imageGenerationToolInputSchema,
    imageGeneratorRequestSchema,
    type GeneratedImage,
    type ImageAsset,
    type ImageGenerationToolInput,
    type ImageGenerator,
} from "../../sources/index.js";

function acceptsPublicTypes(input: {
    readonly toolInput: ImageGenerationToolInput;
    readonly generated: GeneratedImage;
    readonly asset: ImageAsset;
    readonly generator: ImageGenerator;
}): typeof input {
    return input;
}

describe("Image generation exports", () => {
    it("exports the generator, file-backed asset, module option, and tool contracts", () => {
        const generated: GeneratedImage = {
            bytes: new Uint8Array([1, 2, 3]),
            mediaType: "image/png",
        };
        const asset: ImageAsset = {
            id: "asset-1",
            agentId: "agent-1",
            operationId: "operation-1",
            mediaType: "image/png",
            byteLength: generated.bytes.byteLength,
            locator: "/tmp/generated/asset-1.png",
        };
        const generator: ImageGenerator = {
            generate: async () => generated,
        };
        const publicTypes = acceptsPublicTypes({
            toolInput: { prompt: "A blue moon" },
            generated,
            asset,
            generator,
        });
        const request = {
            agentId: "agent-1",
            operationId: "operation-1",
            prompt: publicTypes.toolInput.prompt,
        };

        expect(Value.Check(generatedImageSchema, publicTypes.generated)).toBe(true);
        expect(Value.Check(imageAssetSchema, publicTypes.asset)).toBe(true);
        expect(Value.Check(imageGeneratorRequestSchema, request)).toBe(true);
        expect(
            Value.Check(imageGenerationModuleOptionsSchema, {
                generator: publicTypes.generator,
                outputDirectory: "/tmp/generated",
            }),
        ).toBe(true);
        expect(Value.Check(imageGenerationToolInputSchema, publicTypes.toolInput)).toBe(true);
        expect(
            Value.Check(imageGenerationToolInputSchema, {
                ...publicTypes.toolInput,
                operationId: "model-id",
            }),
        ).toBe(false);
        expect(MAX_IMAGE_OPERATION_CANONICAL_DEPTH).toBe(8);
        expect(MAX_IMAGE_OPERATION_CANONICAL_BYTES).toBe(64 * 1024);
    });
});
