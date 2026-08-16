# Module report: imageGeneration

Reviewed: 2026-08-15. Scope: `packages/happy-agent-modules/sources/imageGeneration/` compared
against `packages/rig/sources/tools/imageGeneration/` (`createImageGenerationTool.ts`,
`imageGenerationSurfaces.ts`), `packages/rig/sources/images/`,
`packages/happy-providers/sources/vendors/codex/tools/imagegen.ts`, root `AGENTS.md`, and master
plans 00, 05, 16, 20, 21.

## Summary

A prompt-to-file capability: a host-owned `ImageGenerator` returns bounded bytes, and the module
writes them atomically to `~/Happy/Generated`, records an operation and asset in the agent's KV
catalog, and returns bounded metadata. The storage half is careful — temp-file-then-rename, one
transaction per outcome, transactional and post-commit listeners, failures recorded rather than
thrown away. The tool half is weaker: the tool name is chosen by branching on the provider, the
approval text interpolates the model's own prompt unescaped, referenced file paths cross the module
with no boundary check at all, and the model never gets to see the image it generated.

## How it differs from Rig's equivalents

- **Tool surface fidelity.** Rig keeps the two surfaces as data
  (`imageGenerationSurfaces.ts`): `imagegen` with a short description, and `codex_imagegen` carrying
  the full vendor guidance Codex models are trained on — the `image_gen` namespace explanation, the
  selector rules, the `view_image` hint, "always use this tool for image editing unless the user
  explicitly requests otherwise", 17 lines in all. The module replaces both with two hand-written
  sentences chosen by a ternary on the tool name (`tools/generate_image.ts:21-24`), discarding the
  vendor-shaped guidance that was the entire reason the Codex surface exists.
- **Approval text.** Rig escapes the model-supplied prompt with `quoteVisibleExact`
  (`createImageGenerationTool.ts:79`). The module interpolates it raw
  (`tools/generate_image.ts:35`) — even though this same package vendors `quoteVisibleExact` for its
  MCP module (`sources/mcp/quoteVisibleExact.ts`).
- **Elevation.** Rig declares `shouldRunInFullAccessInAutoMode` that returns true only when a
  referenced path is outside the boundary (`createImageGenerationTool.ts:86-91`). The module
  declares none at all (`tools/generate_image.ts:28-29`), which is the correct reading of "review
  alone must not imply elevation" — but it also means referenced paths are never checked against a
  boundary by anyone (see finding 3).
- **Output validation.** Rig decodes the base64, checks the PNG signature, and runs the bytes
  through `sharp` with `failOn: "error"` and a pixel limit before writing
  (`createImageGenerationTool.ts:239-270`). The module accepts whatever the generator returns,
  validating only that `mediaType` matches `^image/[A-Za-z0-9.+-]+$` and the byte length is within
  bounds (`ImageGenerator.ts:33-45`, `ImageGenerationModule.ts:196-197`).
- **What the model receives.** Rig's `toLLM` returns a text line *and* an image block
  (`createImageGenerationTool.ts:172-183`). The module's returns text only
  (`tools/generate_image.ts:56-61`).
- **Concurrency.** Rig declares `locks: ["image_generation"]`
  (`createImageGenerationTool.ts:185`). The module declares no lock, so concurrent generations race
  freely.

## Findings

1. **The tool name is chosen by branching on the provider.** `ImageGenerationModule.ts:314-328`:

   ```ts
   const codexSurface =
       scope.agent.providerKind === "codex" ||
       (scope.agent.providerKind === "bedrock" &&
        scope.agent.model?.startsWith("openai/") === true);
   ```

   `AGENTS.md` states: "Never assemble a model's tools by branching on a provider key or a tool-name
   list", and master plan 16 requires that "no model or provider capability classification decides
   which tools exist". A model-ID prefix test (`startsWith("openai/")`) is the classification the
   plan names. Two separate tool definitions merged from fixed arrays is the shape the plan asks
   for; the module has one definition parameterized by a runtime provider check.
2. **The model's prompt is interpolated unescaped into the approval text.**
   `tools/generate_image.ts:35`: `` `sending "${prompt}"…` ``. A prompt containing quotes, newlines,
   or text shaped like the rest of the sentence ("… to image generation. Access: none") is rendered
   verbatim into the string the Auto reviewer reads and a person may see. `AGENTS.md` treats tool
   arguments as untrusted and not authorization evidence; the whole purpose of `quoteVisibleExact`,
   which this package already ships, is to stop model-controlled text from impersonating approval
   text.
3. **Referenced image paths cross the module with no filesystem boundary check.** The tool accepts up
   to five `referenced_image_paths` (`ImageGeneration.ts:143-154`), the module copies them into the
   generator request (`ImageGenerationModule.ts:182-184`), and the host reads them. Nothing resolves
   them, stats them, or compares them against the workspace. Rig resolves each path, rejects
   non-files and oversized files, and enforces a 32 MiB aggregate
   (`createImageGenerationTool.ts:199-230`) *and* asks `shouldReviewPathInAutoMode` about each one.
   Here `/etc/…` or `~/.ssh/…` reaches an external image provider with only the generic
   "conversation data, local filesystem read/write" phrase in the approval text to describe it.
4. **The model never sees the generated image.** `formatForModel`
   (`ImageGenerationModule.ts:330-374`) returns text, and `toLLM` wraps only that text
   (`tools/generate_image.ts:56-61`). The comment on line 330 states the intent — "without exposing
   image bytes" — but for an *editing* workflow the model has to be able to look at what it made to
   decide whether to iterate. The `codex_imagegen` guidance Rig ships even tells the model the image
   "is… returned to you."
5. **The durable catalog is only reachable after `tools()` has run.** `#catalogs` is populated inside
   the `tools` hook (`ImageGenerationModule.ts:315`) and `#catalog` throws otherwise
   (`ImageGenerationModule.ts:376-385`). `README.md:49-58` presents `generate`, `status`, `read`, and
   `remove` as a host API; every one of them throws "Image generation has no durable store yet for
   agent …" until that agent has built its tool list at least once. The map is also never cleared,
   so it grows with every agent the process ever served.
6. **Leftover machinery from a removed idempotency design.** `canonicalize` sorts object keys
   deterministically and `canonicalJson` enforces `MAX_IMAGE_OPERATION_CANONICAL_BYTES` /
   `MAX_IMAGE_OPERATION_CANONICAL_DEPTH` (`ImageGenerationModule.ts:693-733`,
   `ImageGeneration.ts:14-16`). Key-sorted canonicalization exists to fingerprint a request for
   replay detection; `README.md:43` says the module deliberately has no fingerprints or replay
   handling. What remains is used only to measure the size of `options` and to print them, for which
   plain `JSON.stringify` would do.
7. **Prototype-stripping "validation views" to make TypeBox accept class instances.**
   `moduleOptionsValidationView` and `contractValidationView`
   (`ImageGenerationModule.ts:779-802`) walk the prototype chain and rebuild a plain object holding
   just the expected method names so `Value.Check` will pass. This is machinery whose only purpose is
   to work around runtime-validating a typed, compile-time-checked dependency — the same
   anti-pattern flagged in the compute module's `ComputeModule.ts`.
8. **`requirePromise` / `requireVoid` police the return type of typed callbacks.**
   `ImageGenerationModule.ts:753-768`, applied at lines 192, 243, 300, 447, 468, 474, 513, 531. A
   listener that returns anything other than `undefined` throws "… must resolve to undefined." These
   are compile-time facts being re-checked at runtime on every generation.
9. **A crash between file write and commit orphans the file.** The image is written at
   `ImageGenerationModule.ts:204`, before the catalog transaction opens at line 207. A thrown
   transaction removes it best-effort (line 254), but a process death in between leaves an
   unreferenced file in `~/Happy/Generated` with no reconciliation pass.
10. **The output directory is unbounded and unchecked.** `outputDirectory` is any string up to 4,096
    characters (`ImageGenerationModule.ts:72-74`) and is `mkdir -p`'d and written to
    (`ImageGenerationModule.ts:579-595`). The default `~/Happy/Generated`
    (`ImageGenerationModule.ts:55`) is the folder the environment describes as Rig-owned and
    written only by Rig's own media tools; the module writes to it directly with no containment
    check on either the directory or the derived filename.
11. **`extensionForMediaType` invents extensions.** `ImageGenerationModule.ts:563-572` falls back to
    stripping non-alphanumerics out of an arbitrary subtype, or `"bin"`. Since `mediaType` is
    generator-supplied and only pattern-checked, a hostile or buggy generator picks the extension of
    a file the module publishes to a shared user folder.
12. **Package placement contradicts the plans.** Master plans 16 and 21 place ready-made agent
    capabilities in `@slopus/happy-agent-features`; no master plan mentions `happy-agent-modules`.

## What it gets right

The durability story is the strongest part and is done properly. `durable: false`
(`tools/generate_image.ts:27`) is the correct call for billed external work that cannot be safely
replayed, and the README states the reasoning. Writes go to a temp name and are published by
`rename` (`ImageGenerationModule.ts:579-595`), so a reader never sees a partial image. Success and
failure each take exactly one catalog transaction, both reject a reused operation ID rather than
silently replaying (`ImageGenerationModule.ts:208-210`, `424-426`), and a generator failure is
*recorded* as a durable `failed` status instead of vanishing
(`ImageGenerationModule.ts:198-200`). `onEventTransactional` runs inside the committing transaction
and `onEvent` strictly after it, with post-commit listener failures reported rather than allowed to
undo committed state (`ImageGenerationModule.ts:507-537`). Every value crossing a boundary is
`structuredClone`d, so a listener cannot mutate the module's records.

On permissions the tool is declared correctly: `requiresAutoOrFullAccess: true` with
`shouldReviewInAutoMode: () => true` and *no* `shouldRunInFullAccessInAutoMode`
(`tools/generate_image.ts:28-29`), which is exactly the separation `AGENTS.md` demands — review
without automatic elevation. The approval text names the real boundaries being crossed
("conversation data, local filesystem read/write, and external image provider APIs"), and the
operation ID is taken from Agent Base's stable `call.id` rather than invented, with no way for the
model to supply one.
