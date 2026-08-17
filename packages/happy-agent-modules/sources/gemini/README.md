# Gemini

Gemini's media tools, run by the module itself. There is no injected backend and no host
boundary: the module makes the Gemini HTTP calls, and reaches the agent's machine through the
compute module so a generated file lands where every other file tool would put it.

```ts
import { Agent } from "@slopus/happy-agent-base";
import { GeminiModule } from "@slopus/happy-agent-modules";

const gemini = new GeminiModule({ apiKey, compute: computeModule });
const agent = await Agent.create(ctx, { ...options, modules: [gemini] });
```

`apiKey` is required — construct the module only when a Gemini key exists. `compute` is the
`ComputeResolver` the compute module already implements; it is how the module reads and writes
files for one agent, not a host integration. `fetch` is optional and replaces the transport the
requests go out on. One instance serves every agent; an agent with no compute configured receives
no Gemini tools at all, because all three of them touch the filesystem.

## Tools

- **`gemini_imagegen`** — a PNG from Gemini 3.1 Flash Image, saved to `output_path`. The
  path must end in `.png`, checked before anything is generated. `aspect_ratio` and `image_size`
  are optional; the model sees the file path, its size, and whatever Gemini wrote about the image.
- **`gemini_generate_music`** — an MP3 from Lyria 3, saved to `output_path`, which must end in
  `.mp3`. `mode` defaults to `clip` for a short preview; `song` generates a longer full track and
  may cost more. Lyrics and structure come back with the result when Gemini writes them.
- **`gemini_analyze_media`** — one local image, audio, video, or PDF file up to 15 MiB, sent
  inline with the question asked about it. The media type is decided by the file's extension, so a
  file whose kind cannot be named is refused before its bytes leave the machine.

All three are `durable: false`: a generation is billed work that leaves a file behind, so an
interrupted call is reported rather than run a second time. All three require Auto or Full access
and always request Auto review, because they reach an external API outside the local sandbox. The
approval text quotes the model's own prompt and path exactly, with terminal and bidi controls made
visible. Writing or reading outside the workspace, or writing a protected path, additionally runs
the approved call in Full access.

## Files

Generated media is written through the compute filesystem: the path is resolved the way the
machine resolves it, missing directories are created, and the finished file counts as read so a
second generation to the same path is not working blind. A file that already exists must have been
read first, and the read log the module keeps is its own — a generation will not overwrite a file
this module has not written, which is what keeps a prompt from quietly replacing somebody's work.

## Storage

The module persists nothing but that read log. There is no catalog of what was generated, no
event, and no host API: a tool calls Gemini, writes the file, and answers with its path.
