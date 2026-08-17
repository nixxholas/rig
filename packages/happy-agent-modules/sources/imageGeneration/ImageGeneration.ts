import { Type, type Static } from "@sinclair/typebox";

/** How many images one edit may be built from, in either selector. */
export const MAX_EDIT_IMAGES = 5;

/** The encoded request stays within what the image endpoints accept. */
export const MAX_EDIT_IMAGES_ENCODED_BYTES = 48 * 1024 * 1024;

/** The largest source image, and the largest aggregate of them, that an edit may be built from. */
export const MAX_PROMPT_IMAGE_INPUT_BYTES = 32 * 1024 * 1024;

/**
 * What both image surfaces accept.
 *
 * Codex models trained against the built-in image tool send an explicit `null` instead of omitting
 * an unused selector, so both selectors accept it.
 */
export const imageGenerationArgumentsSchema = Type.Object(
    {
        prompt: Type.String({ minLength: 2 }),
        num_last_images_to_include: Type.Optional(
            Type.Union([Type.Integer({ minimum: 1, maximum: MAX_EDIT_IMAGES }), Type.Null()]),
        ),
        referenced_image_paths: Type.Optional(
            Type.Union([Type.Array(Type.String(), { maxItems: MAX_EDIT_IMAGES }), Type.Null()]),
        ),
    },
    { additionalProperties: false },
);

/** The TypeScript type inferred from {@link imageGenerationArgumentsSchema}. */
export type ImageGenerationArguments = Static<typeof imageGenerationArgumentsSchema>;

/** One finished image: where it was saved, and the bytes the model is shown. */
export const imageGenerationResultSchema = Type.Object(
    {
        bytes: Type.Number(),
        media_type: Type.Literal("image/png"),
        path: Type.String(),
        image_base64: Type.String(),
    },
    { additionalProperties: false },
);

/** The TypeScript type inferred from {@link imageGenerationResultSchema}. */
export type ImageGenerationResult = Static<typeof imageGenerationResultSchema>;

/** Reads the local-path selector, treating an explicit `null` as an unused selector. */
export function selectedPaths(args: ImageGenerationArguments): readonly string[] | undefined {
    return args.referenced_image_paths ?? undefined;
}

/** Reads the recent-conversation selector, treating an explicit `null` as an unused selector. */
export function selectedRecentCount(args: ImageGenerationArguments): number | undefined {
    return args.num_last_images_to_include ?? undefined;
}
