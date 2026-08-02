import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { rgbaToThumbHash } from "thumbhash";

import { resolveFileSystemPath } from "../../agent/context/resolveFileSystemPath.js";
import type { AgentContext } from "../../agent/context/AgentContext.js";
import { getImageProcessor } from "../../images/getImageProcessor.js";
import type { Attachment, AttachmentImagePreview } from "./attachmentSchemas.js";
import {
    runBundledMediaCommand,
    type MediaCommandOptions,
    type MediaCommandResult,
} from "./runBundledMediaCommand.js";

export const MAX_ATTACHMENT_FILE_BYTES = 32 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set([
    ".avif",
    ".gif",
    ".heic",
    ".heif",
    ".jpeg",
    ".jpg",
    ".png",
    ".tif",
    ".tiff",
    ".webp",
]);
const VIDEO_EXTENSIONS = new Set([
    ".avi",
    ".m4v",
    ".mkv",
    ".mov",
    ".mp4",
    ".mpeg",
    ".mpg",
    ".webm",
]);
const AUDIO_EXTENSIONS = new Set([
    ".aac",
    ".aiff",
    ".flac",
    ".m4a",
    ".mp3",
    ".ogg",
    ".opus",
    ".wav",
]);
const MEDIA_TYPES = new Map<string, string>([
    [".aac", "audio/aac"],
    [".avif", "image/avif"],
    [".gif", "image/gif"],
    [".jpeg", "image/jpeg"],
    [".jpg", "image/jpeg"],
    [".m4a", "audio/mp4"],
    [".m4v", "video/x-m4v"],
    [".mkv", "video/x-matroska"],
    [".mov", "video/quicktime"],
    [".mp3", "audio/mpeg"],
    [".mp4", "video/mp4"],
    [".mpeg", "video/mpeg"],
    [".mpg", "video/mpeg"],
    [".ogg", "audio/ogg"],
    [".opus", "audio/ogg"],
    [".png", "image/png"],
    [".tif", "image/tiff"],
    [".tiff", "image/tiff"],
    [".wav", "audio/wav"],
    [".webm", "video/webm"],
    [".webp", "image/webp"],
]);

export type ResolvedAttachmentSource =
    | {
          hostPath?: string;
          kind: "file";
          mediaType?: string;
          name: string;
          path: string;
          size: number;
          source: string;
      }
    | { kind: "url"; source: string; url: string };

export interface AttachmentPreparationDependencies {
    runMediaCommand?: (options: MediaCommandOptions) => Promise<MediaCommandResult>;
    signal?: AbortSignal;
}

export async function resolveAttachmentSource(
    args: { path: string } | { url: string },
    context: AgentContext,
): Promise<ResolvedAttachmentSource> {
    if ("url" in args) {
        const url = normalizeHttpUrl(args.url);
        return { kind: "url", source: url, url };
    }

    const requested = resolveFileSystemPath(args.path, context.fs.cwd, context.fs.home);
    const path = await context.fs.realpath(requested);
    const stat = await context.fs.stat(path);
    if (!stat.isFile) throw new Error(`Attachment '${args.path}' is not a file.`);
    if (stat.size > MAX_ATTACHMENT_FILE_BYTES) {
        throw new Error(`Attachment '${args.path}' exceeds the 32 MiB size limit.`);
    }
    const extension = extname(path).toLowerCase();
    const mediaType = MEDIA_TYPES.get(extension);
    return {
        kind: "file",
        ...(mediaType === undefined ? {} : { mediaType }),
        name: basename(path),
        path,
        size: stat.size,
        source: path,
    };
}

export async function prepareAttachment(
    source: ResolvedAttachmentSource,
    id: string,
    context: AgentContext,
    dependencies: AttachmentPreparationDependencies = {},
): Promise<Attachment> {
    if (source.kind === "url") {
        return prepareUrlAttachment(source.url, id, dependencies.signal);
    }
    const extension = extname(source.path).toLowerCase();
    if (IMAGE_EXTENSIONS.has(extension)) return prepareImageAttachment(source, id, context);
    if (VIDEO_EXTENSIONS.has(extension))
        return prepareVideoAttachment(source, id, context, dependencies);
    if (AUDIO_EXTENSIONS.has(extension))
        return prepareAudioAttachment(source, id, context, dependencies);
    return {
        bytes: source.size,
        id,
        kind: "file",
        ...(source.mediaType === undefined ? {} : { mediaType: source.mediaType }),
        name: source.name,
        source: source.source,
    };
}

async function prepareImageAttachment(
    source: Extract<ResolvedAttachmentSource, { kind: "file" }>,
    id: string,
    context: AgentContext,
): Promise<Attachment> {
    const bytes = await context.fs.readFileBuffer(source.path, {
        maxBytes: MAX_ATTACHMENT_FILE_BYTES,
    });
    const image = await imageMetadata(bytes, source.name);
    const { format, ...metadata } = image;
    return {
        bytes: source.size,
        ...metadata,
        id,
        kind: "image",
        mediaType: imageMediaType(format, source.mediaType),
        name: source.name,
        source: source.source,
    };
}

async function prepareVideoAttachment(
    source: Extract<ResolvedAttachmentSource, { kind: "file" }>,
    id: string,
    context: AgentContext,
    dependencies: AttachmentPreparationDependencies,
): Promise<Attachment> {
    if (context.generatedMedia === undefined) {
        throw new Error(
            "Video attachments need Rig-generated media storage, which is unavailable in this execution environment.",
        );
    }
    const mediaPath = source.hostPath ?? source.path;
    const probe = await probeMedia(mediaPath, "video", dependencies);
    const preview = await extractVideoPreview(mediaPath, id, context, dependencies);
    return {
        bytes: source.size,
        duration: probe.duration,
        height: probe.height,
        id,
        kind: "video",
        ...(source.mediaType === undefined ? {} : { mediaType: source.mediaType }),
        name: source.name,
        preview,
        source: source.source,
        width: probe.width,
    };
}

async function prepareAudioAttachment(
    source: Extract<ResolvedAttachmentSource, { kind: "file" }>,
    id: string,
    context: AgentContext,
    dependencies: AttachmentPreparationDependencies,
): Promise<Attachment> {
    const probe =
        source.hostPath !== undefined || dependencies.runMediaCommand !== undefined
            ? await probeMedia(source.hostPath ?? source.path, "audio", dependencies)
            : await probeMediaInExecutionEnvironment(source.path, context, dependencies);
    return {
        bytes: source.size,
        duration: probe.duration,
        id,
        kind: "audio",
        ...(source.mediaType === undefined ? {} : { mediaType: source.mediaType }),
        name: source.name,
        source: source.source,
    };
}

async function probeMedia(
    path: string,
    type: "audio" | "video",
    dependencies: AttachmentPreparationDependencies,
): Promise<{ duration: number; height: number; width: number }> {
    const result = await runMediaCommand(dependencies, "ffprobe", [
        "-v",
        "error",
        ...(type === "video"
            ? ["-select_streams", "v:0", "-show_entries", "stream=width,height"]
            : []),
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        "--",
        path,
    ]);
    const parsed = parseProbeResult(result.stdout, path);
    const duration = asNonNegativeNumber(parsed.format?.duration, "duration", path);
    if (type === "audio") return { duration, height: 0, width: 0 };
    const stream = Array.isArray(parsed.streams) ? parsed.streams[0] : undefined;
    return {
        duration,
        height: asPositiveInteger(stream?.height, "height", path),
        width: asPositiveInteger(stream?.width, "width", path),
    };
}

async function probeMediaInExecutionEnvironment(
    path: string,
    context: AgentContext,
    dependencies: AttachmentPreparationDependencies,
): Promise<{ duration: number; height: number; width: number }> {
    const result = await context.bash.run({
        command: `ffprobe -v error -show_entries format=duration -of json -- ${quoteShellArgument(path)}`,
        cwd: context.fs.cwd,
        maxOutputBytes: 128 * 1024,
        ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
        timeoutMs: 15_000,
    });
    if (result.exitCode !== 0 || result.timedOut) {
        const detail = result.stderr.trim();
        throw new Error(
            detail.length === 0
                ? "Media metadata extraction failed."
                : `Media metadata extraction failed: ${detail}`,
        );
    }
    const parsed = parseProbeResult(result.stdout, path);
    return {
        duration: asNonNegativeNumber(parsed.format?.duration, "duration", path),
        height: 0,
        width: 0,
    };
}

async function extractVideoPreview(
    videoPath: string,
    attachmentId: string,
    context: AgentContext,
    dependencies: AttachmentPreparationDependencies,
): Promise<AttachmentImagePreview> {
    if (context.generatedMedia === undefined) {
        throw new Error("Generated media storage is unavailable for this agent run.");
    }
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "rig-attachment-preview-"));
    const temporaryPath = join(temporaryDirectory, `${randomPreviewId()}.png`);
    try {
        await runMediaCommand(dependencies, "ffmpeg", [
            "-v",
            "error",
            "-y",
            "-ss",
            "0",
            "-i",
            videoPath,
            "-frames:v",
            "1",
            "-f",
            "image2",
            temporaryPath,
        ]);
        const details = await stat(temporaryPath);
        if (!details.isFile() || details.size > MAX_ATTACHMENT_FILE_BYTES) {
            throw new Error("The extracted video preview exceeds the 32 MiB size limit.");
        }
        const bytes = await readFile(temporaryPath);
        const image = await imageMetadata(bytes, temporaryPath);
        const written = await context.generatedMedia.write(bytes, {
            extension: "png",
            preferredName: "video-preview",
        });
        context.attachments?.registerCleanup(attachmentId, () =>
            context.generatedMedia?.remove(written.hostPath),
        );
        return {
            height: image.height,
            mediaType: "image/png",
            path: written.location,
            thumbhash: image.thumbhash,
            width: image.width,
        };
    } finally {
        await rm(temporaryDirectory, { force: true, recursive: true }).catch(() => undefined);
    }
}

async function imageMetadata(
    bytes: Uint8Array,
    label: string,
): Promise<{ format: string | undefined; height: number; thumbhash: string; width: number }> {
    const sharp = await getImageProcessor();
    const image = sharp(bytes, { failOn: "error", limitInputPixels: 40_000_000 });
    const metadata = await image.metadata();
    if (
        metadata.width === undefined ||
        metadata.height === undefined ||
        metadata.width < 1 ||
        metadata.height < 1
    ) {
        throw new Error(`Could not determine dimensions for '${label}'.`);
    }
    const normalized = await image
        .ensureAlpha()
        .resize(100, 100, { fit: "inside", withoutEnlargement: false })
        .raw()
        .toBuffer({ resolveWithObject: true });
    if (normalized.info.width < 1 || normalized.info.height < 1) {
        throw new Error(`Could not create a thumbnail for '${label}'.`);
    }
    return {
        format: metadata.format,
        height: metadata.height,
        thumbhash: Buffer.from(
            rgbaToThumbHash(normalized.info.width, normalized.info.height, normalized.data),
        ).toString("base64"),
        width: metadata.width,
    };
}

async function prepareUrlAttachment(
    url: string,
    id: string,
    signal?: AbortSignal,
): Promise<Attachment> {
    const { checkWebFetchDomain } = await import("../claude/webFetch/checkWebFetchDomain.js");
    const { getWithPermittedRedirects } =
        await import("../claude/webFetch/getWithPermittedRedirects.js");
    await checkWebFetchDomain(new URL(url).hostname, signal);
    const result = await getWithPermittedRedirects(url, signal);
    if ("type" in result) {
        throw new Error(
            `Attachment URL redirected outside its original host: ${result.redirectUrl}`,
        );
    }
    const contentType = result.response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.startsWith("image/")) {
        const image = await imageMetadata(result.raw, url);
        const { format, ...metadata } = image;
        return {
            bytes: result.raw.byteLength,
            ...metadata,
            id,
            kind: "image",
            mediaType: imageMediaType(format, contentType.split(";")[0]),
            name: basename(new URL(url).pathname) || "image",
            source: url,
        };
    }
    if (!contentType.includes("text/html")) {
        throw new Error(
            `Attachment URL did not return an HTML document (${contentType || "unknown type"}).`,
        );
    }
    const metadata = parseUrlMetadata(result.raw.toString("utf8"), result.response.url || url);
    return {
        id,
        kind: "url",
        ...(metadata.description === undefined ? {} : { description: metadata.description }),
        ...(metadata.image === undefined ? {} : { image: metadata.image }),
        ...(metadata.siteName === undefined ? {} : { siteName: metadata.siteName }),
        source: url,
        title: metadata.title,
    };
}

export function parseUrlMetadata(
    html: string,
    url: string,
): { description?: string; image?: string; siteName?: string; title: string } {
    const metas = [...html.matchAll(/<meta\b[^>]*>/giu)].map((match) => attributes(match[0]));
    const meta = (...names: string[]) => {
        for (const attributes of metas) {
            const name = (attributes.property ?? attributes.name ?? "").toLowerCase();
            if (!names.includes(name)) continue;
            const content = normalizedText(attributes.content);
            if (content !== undefined) return content;
        }
        return undefined;
    };
    const title =
        meta("og:title", "twitter:title") ??
        normalizedText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/iu)?.[1]) ??
        new URL(url).hostname;
    const image = meta("og:image", "twitter:image");
    const description = meta("og:description", "twitter:description", "description");
    const siteName = meta("og:site_name");
    return {
        ...(description === undefined ? {} : { description }),
        ...(image === undefined ? {} : { image: new URL(image, url).toString() }),
        ...(siteName === undefined ? {} : { siteName }),
        title,
    };
}

function attributes(value: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const match of value.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gu)) {
        const key = match[1]?.toLowerCase();
        const attribute = match[2] ?? match[3] ?? match[4];
        if (key !== undefined && attribute !== undefined) result[key] = attribute;
    }
    return result;
}

function normalizedText(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    const normalized = value
        .replaceAll(/<[^>]*>/gu, "")
        .replaceAll(/&quot;/giu, '"')
        .replaceAll(/&#39;|&apos;/giu, "'")
        .replaceAll(/&amp;/giu, "&")
        .replaceAll(/\s+/gu, " ")
        .trim();
    return normalized.length === 0 ? undefined : normalized.slice(0, 1_000);
}

const probeNumberSchema = Type.Union([Type.Number(), Type.String()]);
const probeResultSchema = Type.Object(
    {
        format: Type.Optional(
            Type.Object(
                { duration: Type.Optional(probeNumberSchema) },
                { additionalProperties: true },
            ),
        ),
        streams: Type.Optional(
            Type.Array(
                Type.Object(
                    {
                        height: Type.Optional(probeNumberSchema),
                        width: Type.Optional(probeNumberSchema),
                    },
                    { additionalProperties: true },
                ),
            ),
        ),
    },
    { additionalProperties: true },
);
type ProbeResult = Static<typeof probeResultSchema>;

function parseProbeResult(stdout: string, path: string): ProbeResult {
    try {
        const parsed: unknown = JSON.parse(stdout);
        if (!Value.Check(probeResultSchema, parsed)) throw new Error("invalid shape");
        return parsed;
    } catch (error) {
        throw new Error(`ffprobe returned invalid metadata for '${path}'.`, { cause: error });
    }
}

function asNonNegativeNumber(value: unknown, field: string, path: string): number {
    const parsed = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`ffprobe could not determine ${field} for '${path}'.`);
    }
    return parsed;
}

function asPositiveInteger(value: unknown, field: string, path: string): number {
    const parsed = asNonNegativeNumber(value, field, path);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`ffprobe could not determine ${field} for '${path}'.`);
    }
    return parsed;
}

async function runMediaCommand(
    dependencies: AttachmentPreparationDependencies,
    executable: "ffmpeg" | "ffprobe",
    arguments_: readonly string[],
): Promise<MediaCommandResult> {
    const run = dependencies.runMediaCommand ?? runBundledMediaCommand;
    const result = await run({
        arguments: arguments_,
        executable,
        ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
        timeoutMs: 15_000,
    });
    if (result.exitCode !== 0 || result.timedOut) {
        const detail = result.stderr.trim();
        throw new Error(
            detail.length === 0
                ? "Media metadata extraction failed."
                : `Media metadata extraction failed: ${detail}`,
        );
    }
    return result;
}

function imageMediaType(format: string | undefined, fallback: string | undefined): string {
    if (format === "jpeg") return "image/jpeg";
    if (format === "png") return "image/png";
    if (format === "webp") return "image/webp";
    if (format === "gif") return "image/gif";
    if (format === "avif") return "image/avif";
    if (format === "tiff") return "image/tiff";
    return fallback ?? "application/octet-stream";
}

function normalizeHttpUrl(value: string): string {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error(`Invalid attachment URL: ${value}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Attachment URLs must use HTTP or HTTPS.");
    }
    if (url.username || url.password || url.hostname.length === 0 || value.length > 2_000) {
        throw new Error(`Invalid attachment URL: ${value}`);
    }
    url.hash = "";
    return url.toString();
}

function quoteShellArgument(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
}

function randomPreviewId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
