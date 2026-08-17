import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AgentKV,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    imageAgentIdSchema,
    imageAssetIdSchema,
    imageContextSchema,
    imageGenerationInputSchema,
    imageGenerationStatusSchema,
    imageOperationIdSchema,
    MAX_IMAGE_ERROR_CHARACTERS,
    MAX_IMAGE_METADATA_CHARACTERS,
    MAX_IMAGE_OPERATION_CANONICAL_BYTES,
    MAX_IMAGE_OPERATION_CANONICAL_DEPTH,
    MAX_IMAGE_OPTIONS_CHARACTERS,
    MAX_IMAGE_OUTPUT_BYTES,
    MAX_IMAGE_OUTPUT_CHARACTERS,
    type ImageAsset,
    type ImageGenerationInput,
    type ImageGenerationOptions,
    type ImageGenerationStatus,
} from "./ImageGeneration.js";
import {
    assertGeneratedImage,
    imageGeneratorRequestSchema,
    imageGeneratorSchema,
    type GeneratedImage,
    type ImageGenerator,
    type ImageGeneratorRequest,
} from "./ImageGenerator.js";
import {
    imageEventIdSchema,
    imageEventIdFactorySchema,
    imageGenerationEventSchema as eventSchema,
    imageGenerationListenerSchema,
    type ImageGenerationEvent,
    type ImageGenerationListener,
} from "./ImageGenerationEvent.js";
import { generateImageTool } from "./tools/generate_image.js";

const MAX_IMAGE_FEATURE_OUTPUT_CHARACTERS = MAX_IMAGE_OUTPUT_CHARACTERS;
const DEFAULT_MAX_OUTPUT_BYTES = MAX_IMAGE_OUTPUT_BYTES;
const DEFAULT_MAX_OUTPUT_CHARACTERS = MAX_IMAGE_OUTPUT_CHARACTERS;
const DEFAULT_OUTPUT_DIRECTORY = join(homedir(), "Happy", "Generated");
const MAX_OUTPUT_DIRECTORY_CHARACTERS = 4_096;

const operationIdFactorySchema = Type.Function(
    [imageContextSchema, imageAgentIdSchema],
    Type.Promise(imageOperationIdSchema),
);

const postCommitErrorSchema = Type.Function(
    [imageContextSchema, eventSchema, Type.Unknown()],
    Type.Promise(Type.Void()),
);

const imageGenerationModuleOptionsSchema = Type.Object(
    {
        generator: imageGeneratorSchema,
        /** Where generated images are written. Created if missing; defaults to `~/Happy/Generated`. */
        outputDirectory: Type.Optional(
            Type.String({ minLength: 1, maxLength: MAX_OUTPUT_DIRECTORY_CHARACTERS }),
        ),
        idFactory: Type.Optional(operationIdFactorySchema),
        eventIdFactory: Type.Optional(imageEventIdFactorySchema),
        clock: Type.Optional(Type.Function([], Type.Integer({ minimum: 0 }))),
        listener: Type.Optional(imageGenerationListenerSchema),
        maxOutputBytes: Type.Optional(
            Type.Integer({
                minimum: 1,
                maximum: MAX_IMAGE_OUTPUT_BYTES,
            }),
        ),
        maxOutputCharacters: Type.Optional(
            Type.Integer({
                minimum: 256,
                maximum: MAX_IMAGE_FEATURE_OUTPUT_CHARACTERS,
            }),
        ),
        onPostCommitError: Type.Optional(postCommitErrorSchema),
    },
    { additionalProperties: false },
);

export { imageGenerationModuleOptionsSchema };
export type ImageGenerationModuleOptions = Static<typeof imageGenerationModuleOptionsSchema>;

type Operation = {
    readonly agentId: string;
    readonly operationId: string;
    readonly prompt: string;
    readonly options?: ImageGenerationOptions;
    readonly preferredProviderId?: string;
    readonly recentImageCount?: number;
    readonly referencedImagePaths?: readonly string[];
};

/** A completed status record, narrowed for the asset-keyed lookups `read`/`remove` need. */
type CompletedStatus = Extract<ImageGenerationStatus, { status: "completed" }>;

/** One shared image capability: the generator produces bytes, this module owns the disk. */
export class ImageGenerationModule implements AgentModule {
    readonly name = "image-generation";

    readonly #generator: ImageGenerator;
    readonly #outputDirectory: string;
    readonly #idFactory: NonNullable<ImageGenerationModuleOptions["idFactory"]>;
    readonly #eventIdFactory: NonNullable<ImageGenerationModuleOptions["eventIdFactory"]>;
    readonly #clock: NonNullable<ImageGenerationModuleOptions["clock"]>;
    readonly #listener: ImageGenerationListener | undefined;
    readonly #maxOutputBytes: number;
    readonly #maxOutputCharacters: number;
    readonly #onPostCommitError: ImageGenerationModuleOptions["onPostCommitError"];
    /** Each agent's own durable catalog store, captured the first time its tools are built. */
    readonly #catalogs = new Map<string, AgentKV>();

    constructor(options: ImageGenerationModuleOptions) {
        assertImageGenerationModuleOptions(options);
        this.#generator = options.generator;
        this.#outputDirectory = options.outputDirectory ?? DEFAULT_OUTPUT_DIRECTORY;
        this.#idFactory = options.idFactory ?? (async () => globalThis.crypto.randomUUID());
        this.#eventIdFactory =
            options.eventIdFactory ?? (async () => globalThis.crypto.randomUUID());
        this.#clock = options.clock ?? (() => Date.now());
        this.#listener = options.listener;
        this.#maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
        this.#maxOutputCharacters = options.maxOutputCharacters ?? DEFAULT_MAX_OUTPUT_CHARACTERS;
        this.#onPostCommitError = options.onPostCommitError;
        assertOutputBounds(this.#maxOutputBytes, this.#maxOutputCharacters);
    }

    /** Generate one image, write it to a real file on disk, and return its durable status. */
    async generate(
        ctx: Context,
        agentId: string,
        input: ImageGenerationInput,
    ): Promise<ImageGenerationStatus> {
        assertAgentId(agentId);
        const normalized = normalizeInput(input);
        const operationId = normalized.operationId ?? (await this.#newOperationId(ctx, agentId));
        const operation: Operation = {
            agentId,
            operationId,
            prompt: normalized.prompt,
            ...(normalized.options === undefined ? {} : { options: normalized.options }),
            ...(normalized.preferredProviderId === undefined
                ? {}
                : { preferredProviderId: normalized.preferredProviderId }),
            ...(normalized.recentImageCount === undefined
                ? {}
                : { recentImageCount: normalized.recentImageCount }),
            ...(normalized.referencedImagePaths === undefined
                ? {}
                : { referencedImagePaths: normalized.referencedImagePaths }),
        };
        const catalog = this.#catalog(agentId);

        const generatorRequest: ImageGeneratorRequest = {
            agentId: operation.agentId,
            operationId: operation.operationId,
            prompt: operation.prompt,
            ...(operation.options === undefined
                ? {}
                : { options: structuredClone(operation.options) }),
            ...(operation.preferredProviderId === undefined
                ? {}
                : { preferredProviderId: operation.preferredProviderId }),
            ...(operation.recentImageCount === undefined
                ? {}
                : { recentImageCount: operation.recentImageCount }),
            ...(operation.referencedImagePaths === undefined
                ? {}
                : { referencedImagePaths: [...operation.referencedImagePaths] }),
        };
        if (!Value.Check(imageGeneratorRequestSchema, generatorRequest)) {
            throw new Error("Image generation request is invalid.");
        }
        let generated: GeneratedImage;
        try {
            const generatedRaw = this.#generator.generate(ctx, structuredClone(generatorRequest));
            generated = await requirePromise<GeneratedImage>(
                generatedRaw,
                "Image generator generate",
            );
            assertGeneratedImage(generated);
            assertGeneratedBounds(generated, this.#maxOutputBytes);
        } catch (error: unknown) {
            return await this.#recordFailure(catalog, ctx, operation, error);
        }

        const assetId = await this.#newAssetId();
        const fileName = `${assetId}.${extensionForMediaType(generated.mediaType)}`;
        const filePath = await writeImageFile(this.#outputDirectory, fileName, generated.bytes);

        try {
            const outcome = await catalog.transaction(ctx, async (txKV, txCtx) => {
                if ((await this.#readOperation(txKV, txCtx, operationId)) !== undefined) {
                    throw new Error("The image generation operation ID already exists.");
                }

                const now = this.#timestamp();
                const asset: ImageAsset = {
                    id: assetId,
                    agentId,
                    operationId,
                    mediaType: generated.mediaType,
                    byteLength: generated.bytes.byteLength,
                    locator: filePath,
                    ...(generated.width === undefined ? {} : { width: generated.width }),
                    ...(generated.height === undefined ? {} : { height: generated.height }),
                    ...(generated.metadata === undefined ? {} : { metadata: generated.metadata }),
                };
                const status: ImageGenerationStatus = {
                    agentId,
                    operationId,
                    prompt: operation.prompt,
                    ...(operation.options === undefined ? {} : { options: operation.options }),
                    status: "completed",
                    createdAt: now,
                    updatedAt: now,
                    asset,
                };
                if (!Value.Check(imageGenerationStatusSchema, status)) {
                    throw new Error("Image generation module created an invalid status.");
                }

                await txKV.write(txCtx, operationKey(operationId), status);
                await txKV.write(txCtx, assetKey(assetId), operationId);
                const event = await this.#event(txCtx, operation, status);
                const transactional = this.#listener?.onEventTransactional;
                if (transactional !== undefined) {
                    await requireVoid(
                        transactional.call(this.#listener, txCtx, event),
                        "Image transactional listener",
                    );
                }
                return { status, event };
            });

            await this.#emit(ctx, outcome.event);
            return structuredClone(outcome.status);
        } catch (error: unknown) {
            await removeFileBestEffort(filePath);
            throw error;
        }
    }

    /** Read one operation status; an unknown operation returns undefined. */
    async status(
        ctx: Context,
        agentId: string,
        operationId: string,
    ): Promise<ImageGenerationStatus | undefined> {
        assertAgentId(agentId);
        assertOperationId(operationId);
        const value = await this.#readOperation(this.#catalog(agentId), ctx, operationId);
        return value === undefined ? undefined : structuredClone(value);
    }

    /** Read bounded protocol-safe metadata for one generated asset. */
    async read(ctx: Context, agentId: string, assetId: string): Promise<ImageAsset | undefined> {
        assertAgentId(agentId);
        assertAssetId(assetId);
        const status = await this.#readOperationByAsset(this.#catalog(agentId), ctx, assetId);
        return status === undefined ? undefined : structuredClone(status.asset);
    }

    /** Remove one owned asset's durable record and its file on disk. */
    async remove(ctx: Context, agentId: string, assetId: string): Promise<boolean> {
        assertAgentId(agentId);
        assertAssetId(assetId);
        const catalog = this.#catalog(agentId);
        const outcome = await catalog.transaction(ctx, async (txKV, txCtx) => {
            const status = await this.#readOperationByAsset(txKV, txCtx, assetId);
            if (status === undefined) return { removed: false as const };
            await txKV.delete(txCtx, operationKey(status.operationId));
            await txKV.delete(txCtx, assetKey(assetId));
            const eventId = await this.#newEventId(txCtx, agentId, assetId);
            const event: ImageGenerationEvent = {
                type: "image_removed",
                eventId,
                at: this.#timestamp(),
                agentId,
                assetId,
            };
            assertEvent(event);
            const transactional = this.#listener?.onEventTransactional;
            if (transactional !== undefined) {
                await requireVoid(
                    transactional.call(this.#listener, txCtx, event),
                    "Image transactional listener",
                );
            }
            return { removed: true as const, filePath: status.asset.locator, event };
        });
        if (!outcome.removed) return false;
        await removeFileBestEffort(outcome.filePath);
        await this.#emit(ctx, outcome.event);
        return true;
    }

    readonly #hooks: AgentModuleHooks = {
        /** Provider-shaped ordinary tool names over the same provider-neutral host generator. */
        tools: (_ctx: Context, scope: AgentModuleScope): readonly AnyAgentTool[] => {
            this.#catalogs.set(scope.agent.id, scope.kv.scoped("catalog"));
            const codexSurface =
                scope.agent.providerKind === "codex" ||
                (scope.agent.providerKind === "bedrock" &&
                    scope.agent.model?.startsWith("openai/") === true);
            return [
                generateImageTool(
                    this,
                    scope.agent.id,
                    codexSurface ? "codex_imagegen" : "imagegen",
                    scope.agent.provider,
                ),
            ];
        },
    };

    readonly beforeStart = (): AgentModuleHooks => this.#hooks;

    /** Render bounded metadata the model can use without exposing image bytes. */
    formatForModel(
        status: ImageGenerationStatus,
        maxCharacters = this.#maxOutputCharacters,
    ): string {
        assertImageGenerationStatus(status);
        if (
            !Number.isInteger(maxCharacters) ||
            maxCharacters < 256 ||
            maxCharacters > MAX_IMAGE_FEATURE_OUTPUT_CHARACTERS
        ) {
            throw new Error("Image generation output character bound is invalid.");
        }
        const identity =
            status.status === "completed"
                ? [
                      `Operation ID: ${status.operationId}`,
                      `Asset ID: ${status.asset.id}`,
                      `Media type: ${status.asset.mediaType}`,
                      `Path: ${status.asset.locator}`,
                  ]
                : [`Image generation ${status.status}.`, `Operation ID: ${status.operationId}`];
        const required = identity.join("\n");
        if (required.length > maxCharacters) {
            throw new Error("Image generation identity cannot fit the output bound.");
        }
        const optional = [
            ...(status.status === "completed"
                ? ["Image generation completed."]
                : [`Status: ${status.status}`]),
            `Prompt: ${status.prompt}`,
            ...(status.options === undefined ? [] : [`Options: ${canonicalJson(status.options)}`]),
            ...(status.status === "completed"
                ? [`Size: ${String(status.asset.byteLength)} bytes`]
                : []),
            ...(status.status === "failed" ? [`Error: ${status.error}`] : []),
        ];
        let output = required;
        for (const line of optional) {
            const candidate = `${output}\n${line}`;
            if (candidate.length > maxCharacters) break;
            output = candidate;
        }
        return output;
    }

    #catalog(agentId: string): AgentKV {
        const catalog = this.#catalogs.get(agentId);
        if (catalog === undefined) {
            throw new Error(
                `Image generation has no durable store yet for agent "${agentId}"; the agent ` +
                    "must be started at least once before image generation can be used.",
            );
        }
        return catalog;
    }

    async #readOperation(
        kv: AgentKV,
        ctx: Context,
        operationId: string,
    ): Promise<ImageGenerationStatus | undefined> {
        const value = await kv.read(ctx, operationKey(operationId));
        if (value === undefined) return undefined;
        if (!Value.Check(imageGenerationStatusSchema, value) || value.operationId !== operationId) {
            throw new Error("Image generation catalog entry is corrupt.");
        }
        return value;
    }

    async #readOperationByAsset(
        kv: AgentKV,
        ctx: Context,
        assetId: string,
    ): Promise<CompletedStatus | undefined> {
        const operationId = await kv.read(ctx, assetKey(assetId));
        if (operationId === undefined) return undefined;
        if (typeof operationId !== "string") {
            throw new Error("Image generation asset index is corrupt.");
        }
        const status = await this.#readOperation(kv, ctx, operationId);
        if (status === undefined || status.status !== "completed" || status.asset.id !== assetId) {
            return undefined;
        }
        return status;
    }

    async #recordFailure(
        catalog: AgentKV,
        ctx: Context,
        operation: Operation,
        error: unknown,
    ): Promise<ImageGenerationStatus> {
        const outcome = await catalog.transaction(ctx, async (txKV, txCtx) => {
            if ((await this.#readOperation(txKV, txCtx, operation.operationId)) !== undefined) {
                throw new Error("The image generation operation ID already exists.");
            }

            const now = this.#timestamp();
            const status: ImageGenerationStatus = {
                agentId: operation.agentId,
                operationId: operation.operationId,
                prompt: operation.prompt,
                ...(operation.options === undefined ? {} : { options: operation.options }),
                status: "failed",
                createdAt: now,
                updatedAt: now,
                error: safeGenerationError(error),
            };
            if (!Value.Check(imageGenerationStatusSchema, status)) {
                throw new Error("Image generation module created an invalid failure status.");
            }

            await txKV.write(txCtx, operationKey(operation.operationId), status);
            const event = await this.#event(txCtx, operation, status);
            const transactional = this.#listener?.onEventTransactional;
            if (transactional !== undefined) {
                await requireVoid(
                    transactional.call(this.#listener, txCtx, event),
                    "Image transactional listener",
                );
            }
            return { status, event };
        });
        await this.#emit(ctx, outcome.event);
        return structuredClone(outcome.status);
    }

    async #newAssetId(): Promise<string> {
        const assetId = globalThis.crypto.randomUUID();
        if (!Value.Check(imageAssetIdSchema, assetId)) {
            throw new Error("Image generation module created an invalid asset ID.");
        }
        return assetId;
    }

    async #newOperationId(ctx: Context, agentId: string): Promise<string> {
        const value = this.#idFactory(ctx, agentId);
        const operationId = await requirePromise<string>(value, "Image operation ID factory");
        assertOperationId(operationId);
        return operationId;
    }

    async #newEventId(ctx: Context, agentId: string, operationId: string): Promise<string> {
        const value = this.#eventIdFactory(ctx, agentId, operationId);
        const eventId = await requirePromise<string>(value, "Image event ID factory");
        if (!Value.Check(imageEventIdSchema, eventId)) {
            throw new Error("Image event ID factory returned an invalid ID.");
        }
        return eventId;
    }

    #timestamp(): number {
        const at = this.#clock();
        if (!Value.Check(Type.Integer({ minimum: 0 }), at)) {
            throw new Error("Image generation clock returned an invalid timestamp.");
        }
        return at;
    }

    async #event(
        ctx: Context,
        operation: Operation,
        status: ImageGenerationStatus,
    ): Promise<ImageGenerationEvent> {
        const event = {
            type: "image_generation_changed" as const,
            eventId: await this.#newEventId(ctx, status.agentId, operation.operationId),
            at: this.#timestamp(),
            agentId: status.agentId,
            operationId: operation.operationId,
            operation: structuredClone(status),
        };
        assertEvent(event);
        return event;
    }

    /** Fire the post-commit listener for one event, reporting a listener failure rather than throwing. */
    async #emit(ctx: Context, event: ImageGenerationEvent | undefined): Promise<void> {
        if (event === undefined) return;
        const listener = this.#listener?.onEvent;
        if (listener === undefined) return;
        try {
            await requireVoid(
                listener.call(this.#listener, ctx, event),
                "Image post-commit listener",
            );
        } catch (error: unknown) {
            await this.#reportPostCommitError(ctx, event, error);
        }
    }

    async #reportPostCommitError(
        ctx: Context,
        event: ImageGenerationEvent,
        error: unknown,
    ): Promise<void> {
        const report = this.#onPostCommitError;
        if (report === undefined) return;
        try {
            await requireVoid(
                report.call(this, ctx, event, safeError(error)),
                "Image post-commit error reporter",
            );
        } catch {
            // Reporting is advisory after durable state has settled.
        }
    }
}

function operationKey(operationId: string): string {
    return `operation.${operationId}`;
}

function assetKey(assetId: string): string {
    return `asset.${assetId}`;
}

const MEDIA_TYPE_EXTENSIONS: Readonly<Record<string, string>> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/svg+xml": "svg",
    "image/bmp": "bmp",
    "image/tiff": "tiff",
    "image/avif": "avif",
    "image/heic": "heic",
    "image/heif": "heif",
};

/** The conventional file extension for a validated `image/...` media type. */
function extensionForMediaType(mediaType: string): string {
    const known = MEDIA_TYPE_EXTENSIONS[mediaType.toLowerCase()];
    if (known !== undefined) return known;
    const subtype = mediaType
        .slice("image/".length)
        .toLowerCase()
        .replace(/\+xml$/, "");
    const cleaned = subtype.replace(/[^a-z0-9]/g, "");
    return cleaned.length > 0 ? cleaned : "bin";
}

/**
 * Write bytes to `directory/fileName` so a reader never observes a partial file: the bytes land
 * at a temporary name first, and only a rename — atomic on the same filesystem — publishes them
 * under their final name.
 */
async function writeImageFile(
    directory: string,
    fileName: string,
    bytes: Uint8Array,
): Promise<string> {
    await mkdir(directory, { recursive: true });
    const finalPath = join(directory, fileName);
    const tempPath = join(directory, `.tmp-${globalThis.crypto.randomUUID()}-${fileName}`);
    try {
        await writeFile(tempPath, bytes, { flag: "wx" });
        await rename(tempPath, finalPath);
    } catch (error: unknown) {
        await removeFileBestEffort(tempPath);
        throw error;
    }
    return finalPath;
}

/** Best-effort cleanup: once a durable record no longer references a path, its file is orphaned. */
async function removeFileBestEffort(filePath: string): Promise<void> {
    try {
        await rm(filePath, { force: true });
    } catch {
        // Best-effort; nothing further references this path once it is unreachable.
    }
}

function normalizeInput(input: ImageGenerationInput): ImageGenerationInput {
    if (!Value.Check(imageGenerationInputSchema, input)) {
        throw new Error("Image generation input is invalid.");
    }
    const prompt = input.prompt.trim();
    const normalized = {
        prompt,
        ...(input.options === undefined ? {} : { options: structuredClone(input.options) }),
        ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
        ...(input.preferredProviderId === undefined
            ? {}
            : { preferredProviderId: input.preferredProviderId }),
        ...(input.recentImageCount === undefined
            ? {}
            : { recentImageCount: input.recentImageCount }),
        ...(input.referencedImagePaths === undefined
            ? {}
            : { referencedImagePaths: [...input.referencedImagePaths] }),
    };
    if (!Value.Check(imageGenerationInputSchema, normalized)) {
        throw new Error("Image prompt must not be empty and must be within the character limit.");
    }
    if (encodedBytes(normalized.options) > MAX_IMAGE_OPTIONS_CHARACTERS) {
        throw new Error("Image generation options exceed the configured bound.");
    }
    if (
        normalized.recentImageCount !== undefined &&
        normalized.referencedImagePaths !== undefined
    ) {
        throw new Error(
            "Provide only one of referenced image paths or recent conversation images.",
        );
    }
    return normalized;
}

function assertOutputBounds(maxBytes: number, maxCharacters: number): void {
    if (
        !Value.Check(Type.Integer({ minimum: 1, maximum: MAX_IMAGE_OUTPUT_BYTES }), maxBytes) ||
        !Value.Check(
            Type.Integer({ minimum: 256, maximum: MAX_IMAGE_FEATURE_OUTPUT_CHARACTERS }),
            maxCharacters,
        )
    ) {
        throw new Error("Image generation output bounds are invalid.");
    }
}

function assertGeneratedBounds(generated: GeneratedImage, maxBytes: number): void {
    if (generated.bytes.byteLength > maxBytes) {
        throw new Error(`Image generator output exceeds the ${String(maxBytes)} byte limit.`);
    }
    if (encodedBytes(generated.metadata) > MAX_IMAGE_METADATA_CHARACTERS) {
        throw new Error("Image generator metadata exceeds the configured bound.");
    }
}

function assertAgentId(agentId: string): void {
    if (!Value.Check(imageAgentIdSchema, agentId)) {
        throw new Error("Image generation agent ID is invalid.");
    }
}

function assertOperationId(operationId: string): void {
    if (!Value.Check(imageOperationIdSchema, operationId)) {
        throw new Error("Image generation operation ID is invalid.");
    }
}

function assertAssetId(assetId: string): void {
    if (!Value.Check(imageAssetIdSchema, assetId)) {
        throw new Error("Image asset ID is invalid.");
    }
}

function assertImageGenerationStatus(value: unknown): asserts value is ImageGenerationStatus {
    if (!Value.Check(imageGenerationStatusSchema, value)) {
        throw new Error("Image generation status is invalid.");
    }
}

function assertEvent(event: unknown): asserts event is ImageGenerationEvent {
    if (!Value.Check(eventSchema, event)) {
        throw new Error("Image generation module created an invalid event.");
    }
}

function canonicalJson(value: unknown): string {
    let encoded: string | undefined;
    try {
        encoded = JSON.stringify(canonicalize(value));
    } catch {
        throw new Error("Image generation input is not canonicalizable.");
    }
    if (encoded === undefined) throw new Error("Image generation input is not serializable.");
    if (new TextEncoder().encode(encoded).byteLength > MAX_IMAGE_OPERATION_CANONICAL_BYTES) {
        throw new Error("Image generation input exceeds the canonicalization byte bound.");
    }
    return encoded;
}

function encodedBytes(value: unknown): number {
    if (value === undefined) return 0;
    return new TextEncoder().encode(canonicalJson(value)).byteLength;
}

function canonicalize(value: unknown, seen = new Set<object>(), depth = 0): unknown {
    if (depth > MAX_IMAGE_OPERATION_CANONICAL_DEPTH) {
        throw new Error("Image generation input is too deeply nested.");
    }
    if (Array.isArray(value)) {
        if (seen.has(value)) throw new Error("cyclic image input");
        seen.add(value);
        const result = value.map((entry) => canonicalize(entry, seen, depth + 1));
        seen.delete(value);
        return result;
    }
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) throw new Error("cyclic image input");
    seen.add(value);
    const result = Object.fromEntries(
        Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, nested]) => [key, canonicalize(nested, seen, depth + 1)]),
    );
    seen.delete(value);
    return result;
}

function safeError(error: unknown): string {
    try {
        const message = error instanceof Error ? error.message : String(error);
        return message.slice(0, 512) || "Unknown image observer error.";
    } catch {
        return "Unknown image observer error.";
    }
}

function safeGenerationError(error: unknown): string {
    try {
        const message = error instanceof Error ? error.message : String(error);
        return message.slice(0, MAX_IMAGE_ERROR_CHARACTERS) || "Unknown image generation error.";
    } catch {
        return "Unknown image generation error.";
    }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
    return (
        ((typeof value === "object" && value !== null) || typeof value === "function") &&
        typeof (value as { then?: unknown }).then === "function"
    );
}

async function requirePromise<T>(value: unknown, operation: string): Promise<T> {
    if (!isPromiseLike(value)) throw new Error(`${operation} must return a Promise.`);
    return (await value) as T;
}

async function requireVoid(value: unknown, operation: string): Promise<void> {
    const resolved = await requirePromise<unknown>(value, operation);
    if (resolved !== undefined) throw new Error(`${operation} must resolve to undefined.`);
}

export function assertImageGenerationModuleOptions(
    value: unknown,
): asserts value is ImageGenerationModuleOptions {
    const candidate = moduleOptionsValidationView(value);
    if (!Value.Check(imageGenerationModuleOptionsSchema, candidate)) {
        throw new Error("Image generation module options are invalid.");
    }
}

function moduleOptionsValidationView(value: unknown): unknown {
    if (value === null || typeof value !== "object") return value;
    const object = value as Record<string, unknown>;
    return {
        ...object,
        generator: contractValidationView(object.generator, ["generate"]),
        ...(object.listener === undefined
            ? {}
            : {
                  listener: contractValidationView(object.listener, [
                      "onEventTransactional",
                      "onEvent",
                  ]),
              }),
    };
}

function contractValidationView(value: unknown, keys: readonly string[]): unknown {
    if (value === null || typeof value !== "object") return value;
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) return value;
    const object = value as Record<string, unknown>;
    return Object.fromEntries(keys.map((key) => [key, object[key]]));
}
