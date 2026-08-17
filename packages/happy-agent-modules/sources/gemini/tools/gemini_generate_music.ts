import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";

import type { Compute } from "../../compute/Compute.js";
import type { FileReadLog } from "../../compute/impl/FileReadLog.js";
import { shouldReviewComputePath } from "../../compute/impl/shouldReviewComputePath.js";
import { quoteVisibleExact } from "../../mcp/quoteVisibleExact.js";
import type { GeminiConnection } from "../Gemini.js";
import { computePathExtension } from "../impl/computePathExtension.js";
import { generateGeminiMusic } from "../impl/generateGeminiMusic.js";
import { prepareGeneratedMediaOutputPath } from "../impl/prepareGeneratedMediaOutputPath.js";
import { writeGeneratedMediaFile } from "../impl/writeGeneratedMediaFile.js";

const generatedMusicSchema = Type.Object({
    bytes: Type.Number(),
    lyrics: Type.Optional(Type.String()),
    mime_type: Type.String(),
    path: Type.String(),
});

/** Lyria's music generation, written straight to a file on the agent's machine. */
export function geminiGenerateMusicTool(
    connection: GeminiConnection,
    compute: Compute,
    reads: FileReadLog,
) {
    return defineAgentTool({
        name: "gemini_generate_music",
        description:
            "Generate MP3 music with Lyria 3 and save it locally. Clip mode creates a 30-second preview; song mode creates a longer full song and may cost more.",
        parameters: Type.Object({
            prompt: Type.String({
                minLength: 2,
                description:
                    "Music prompt describing style, instruments, mood, structure, and lyrics",
            }),
            output_path: Type.String({ description: "Local output path ending in .mp3" }),
            mode: Type.Optional(
                Type.Union([Type.Literal("clip"), Type.Literal("song")], {
                    description: "Defaults to clip; song generates a longer full-length track",
                }),
            ),
        }),
        returnType: generatedMusicSchema,
        // Generating a track is billed work that leaves a file behind, so an interrupted call is
        // reported rather than run a second time.
        durable: false,
        requiresAutoOrFullAccess: true,
        describeAutoPermissionAction: ({ prompt, output_path }) =>
            `sending ${quoteVisibleExact(prompt)} to Gemini music generation and writing ${quoteVisibleExact(output_path)}. Access: external Gemini API and local filesystem write`,
        shouldReviewInAutoMode: () => true,
        shouldRunInFullAccessInAutoMode: ({ output_path }, ctx) =>
            shouldReviewComputePath(compute, output_path, { write: true }, ctx),
        execute: async (ctx, { prompt, output_path, mode }) => {
            if (computePathExtension(output_path) !== ".mp3") {
                throw new Error("Gemini music output_path must end in .mp3.");
            }
            const resolvedOutputPath = await prepareGeneratedMediaOutputPath(
                compute,
                reads,
                ctx,
                output_path,
            );
            const generated = await generateGeminiMusic({
                apiKey: connection.apiKey,
                ...(connection.fetch === undefined ? {} : { fetch: connection.fetch }),
                mode: mode ?? "clip",
                prompt,
                ...(ctx.lifetime === undefined ? {} : { signal: ctx.lifetime }),
            });
            if (!["audio/mp3", "audio/mpeg"].includes(generated.mimeType)) {
                throw new Error(`Gemini returned unsupported music type '${generated.mimeType}'.`);
            }
            const path = await writeGeneratedMediaFile(
                compute,
                reads,
                ctx,
                resolvedOutputPath,
                generated.bytes,
            );
            return {
                bytes: generated.bytes.byteLength,
                ...(generated.text === undefined ? {} : { lyrics: generated.text }),
                mime_type: generated.mimeType,
                path,
            };
        },
        toLLM: (result) => [
            {
                type: "text",
                text: `Generated music at ${result.path} (${String(result.bytes)} bytes).${result.lyrics === undefined ? "" : `\n\nLyrics and structure:\n${result.lyrics}`}`,
            },
        ],
    });
}
