import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

/**
 * Image generation is deliberately provider-neutral for the prompt-to-bytes step. The host
 * chooses the provider and account that produce the image; this module owns turning those bytes
 * into a real file on disk and transports bounded metadata and opaque identities around that file.
 */
export const MAX_IMAGE_PROMPT_CHARACTERS = 8_000;
export const MAX_IMAGE_OPTIONS_CHARACTERS = 8_000;
export const MAX_IMAGE_METADATA_CHARACTERS = 8_000;
export const MAX_IMAGE_OUTPUT_BYTES = 50 * 1024 * 1024;
export const MAX_IMAGE_OUTPUT_CHARACTERS = 12_000;
/** Canonicalized options and model output are bounded before they are serialized. */
export const MAX_IMAGE_OPERATION_CANONICAL_DEPTH = 8;
export const MAX_IMAGE_OPERATION_CANONICAL_BYTES = 64 * 1024;
/**
 * Operation, agent, and asset identities stay short enough for a compact completed-generation
 * result to retain every actionable identity at the minimum model output budget. 48 characters
 * still admits UUID-shaped host identities.
 */
export const MAX_IMAGE_ID_CHARACTERS = 48;
/**
 * A locator is the absolute path of the file the module wrote, so the bound follows a generous
 * real-world OS path length instead of the tighter budget an opaque host reference once needed.
 */
export const MAX_IMAGE_LOCATOR_CHARACTERS = 1_024;
export const MAX_IMAGE_ERROR_CHARACTERS = 2_000;
export const MAX_IMAGE_METADATA_PROPERTIES = 32;
export const MAX_IMAGE_METADATA_VALUE_CHARACTERS = 1_024;
export const MAX_IMAGE_REFERENCES = 5;

/** Context is host-owned and opaque, but injected callbacks still require an object boundary. */
export const imageContextSchema = Type.Unsafe<Context>(
    Type.Object({}, { additionalProperties: true }),
);

export const imageAgentIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_IMAGE_ID_CHARACTERS,
    pattern: "^[^\\u0000\\r\\n]+$",
});

export const imageOperationIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_IMAGE_ID_CHARACTERS,
    pattern: "^[^\\u0000\\r\\n]+$",
});

export const imageAssetIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_IMAGE_ID_CHARACTERS,
    pattern: "^[^\\u0000\\r\\n]+$",
});

export const imagePromptSchema = Type.String({
    minLength: 1,
    maxLength: MAX_IMAGE_PROMPT_CHARACTERS,
});

export const imageMediaTypeSchema = Type.String({
    minLength: 7,
    maxLength: 32,
    pattern: "^image/[A-Za-z0-9.+-]+$",
});

/** The absolute path of the file this module wrote the generated image to on disk. */
export const imageAssetLocatorSchema = Type.String({
    minLength: 1,
    maxLength: MAX_IMAGE_LOCATOR_CHARACTERS,
    pattern: "^[^\\u0000\\r\\n]+$",
});

export const imageDimensionSchema = Type.Integer({
    minimum: 1,
    maximum: 100_000,
});

const imageMetadataKeySchema = Type.String({
    minLength: 1,
    maxLength: 128,
    pattern: "^[^\\u0000\\r\\n]+$",
});

const imageMetadataValueSchema = Type.Union([
    Type.String({ maxLength: MAX_IMAGE_METADATA_VALUE_CHARACTERS }),
    Type.Number(),
    Type.Boolean(),
    Type.Null(),
]);

/**
 * Metadata is intentionally flat and primitive. This gives hosts useful protocol-safe details
 * while making the total size and validation cost explicit.
 */
export const imageMetadataSchema = Type.Record(imageMetadataKeySchema, imageMetadataValueSchema, {
    maxProperties: MAX_IMAGE_METADATA_PROPERTIES,
});

/**
 * Generation options are provider-neutral hints. A host may ignore a hint, but an adapter may not
 * smuggle an unbounded provider request through this module.
 */
export const imageGenerationOptionsSchema = Type.Object(
    {
        size: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 64,
                pattern: "^[^\\u0000\\r\\n]+$",
            }),
        ),
        width: Type.Optional(imageDimensionSchema),
        height: Type.Optional(imageDimensionSchema),
        aspectRatio: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 32,
                pattern: "^[^\\u0000\\r\\n]+$",
            }),
        ),
        quality: Type.Optional(
            Type.Union([Type.Literal("draft"), Type.Literal("standard"), Type.Literal("high")]),
        ),
        style: Type.Optional(
            Type.String({
                maxLength: 512,
                pattern: "^[^\\u0000\\r\\n]*$",
            }),
        ),
        seed: Type.Optional(Type.Integer({ minimum: 0, maximum: 2_147_483_647 })),
    },
    { additionalProperties: false },
);

/** Public generation input. The model cannot provide an operation identity. */
export const imageGenerationToolInputSchema = Type.Object(
    {
        prompt: imagePromptSchema,
        num_last_images_to_include: Type.Optional(
            Type.Union([Type.Integer({ minimum: 1, maximum: MAX_IMAGE_REFERENCES }), Type.Null()]),
        ),
        referenced_image_paths: Type.Optional(
            Type.Union([
                Type.Array(
                    Type.String({
                        minLength: 1,
                        maxLength: MAX_IMAGE_LOCATOR_CHARACTERS,
                    }),
                    { maxItems: MAX_IMAGE_REFERENCES },
                ),
                Type.Null(),
            ]),
        ),
    },
    { additionalProperties: false },
);

/** Host callers may provide an operation identity they own or let the module allocate one. */
export const imageGenerationInputSchema = Type.Object(
    {
        prompt: imagePromptSchema,
        options: Type.Optional(imageGenerationOptionsSchema),
        operationId: Type.Optional(imageOperationIdSchema),
        preferredProviderId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        recentImageCount: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_IMAGE_REFERENCES }),
        ),
        referencedImagePaths: Type.Optional(
            Type.Array(
                Type.String({
                    minLength: 1,
                    maxLength: MAX_IMAGE_LOCATOR_CHARACTERS,
                }),
                { maxItems: MAX_IMAGE_REFERENCES },
            ),
        ),
    },
    { additionalProperties: false },
);

export const imageGenerationStatusKindSchema = Type.Union([
    Type.Literal("pending"),
    Type.Literal("completed"),
    Type.Literal("failed"),
]);

const imageGenerationStatusIdentity = {
    operationId: imageOperationIdSchema,
    agentId: imageAgentIdSchema,
    prompt: imagePromptSchema,
    options: Type.Optional(imageGenerationOptionsSchema),
};

export const imageAssetSchema = Type.Object(
    {
        id: imageAssetIdSchema,
        /** Asset ownership is part of the durable record, not inferred from a query. */
        agentId: imageAgentIdSchema,
        operationId: imageOperationIdSchema,
        mediaType: imageMediaTypeSchema,
        byteLength: Type.Integer({ minimum: 1, maximum: MAX_IMAGE_OUTPUT_BYTES }),
        locator: imageAssetLocatorSchema,
        width: Type.Optional(imageDimensionSchema),
        height: Type.Optional(imageDimensionSchema),
        metadata: Type.Optional(imageMetadataSchema),
    },
    { additionalProperties: false },
);

const imageGenerationPendingSchema = Type.Object(
    {
        ...imageGenerationStatusIdentity,
        status: Type.Literal("pending"),
        createdAt: Type.Integer({ minimum: 0 }),
        updatedAt: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
);

const imageGenerationCompletedSchema = Type.Object(
    {
        ...imageGenerationStatusIdentity,
        status: Type.Literal("completed"),
        createdAt: Type.Integer({ minimum: 0 }),
        updatedAt: Type.Integer({ minimum: 0 }),
        asset: imageAssetSchema,
    },
    { additionalProperties: false },
);

const imageGenerationFailedSchema = Type.Object(
    {
        ...imageGenerationStatusIdentity,
        status: Type.Literal("failed"),
        createdAt: Type.Integer({ minimum: 0 }),
        updatedAt: Type.Integer({ minimum: 0 }),
        error: Type.String({
            minLength: 1,
            maxLength: MAX_IMAGE_ERROR_CHARACTERS,
        }),
    },
    { additionalProperties: false },
);

export const imageGenerationStatusSchema = Type.Union([
    imageGenerationPendingSchema,
    imageGenerationCompletedSchema,
    imageGenerationFailedSchema,
]);

export const imageGenerationStatusResultSchema = Type.Union([
    imageGenerationStatusSchema,
    Type.Undefined(),
    Type.Null(),
]);

export const imageGenerationStatusQuerySchema = Type.Object(
    {
        agentId: imageAgentIdSchema,
        operationId: imageOperationIdSchema,
    },
    { additionalProperties: false },
);

export const imageAssetQuerySchema = Type.Object(
    {
        agentId: imageAgentIdSchema,
        assetId: imageAssetIdSchema,
    },
    { additionalProperties: false },
);

export type ImageAgentId = Static<typeof imageAgentIdSchema>;
export type ImageOperationId = Static<typeof imageOperationIdSchema>;
export type ImageAssetId = Static<typeof imageAssetIdSchema>;
export type ImagePrompt = Static<typeof imagePromptSchema>;
export type ImageMediaType = Static<typeof imageMediaTypeSchema>;
export type ImageMetadata = Static<typeof imageMetadataSchema>;
export type ImageAsset = Static<typeof imageAssetSchema>;
export type ImageGenerationOptions = Static<typeof imageGenerationOptionsSchema>;
export type ImageGenerationInput = Static<typeof imageGenerationInputSchema>;
export type ImageGenerationToolInput = Static<typeof imageGenerationToolInputSchema>;
export type ImageGenerationStatus = Static<typeof imageGenerationStatusSchema>;
export type ImageGenerationStatusQuery = Static<typeof imageGenerationStatusQuerySchema>;
export type ImageAssetQuery = Static<typeof imageAssetQuerySchema>;
