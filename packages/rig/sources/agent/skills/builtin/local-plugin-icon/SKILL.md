---
name: local-plugin-icon
description: Automatically use when creating or editing a local Happy plugin, happy.plugin.json, or its required PNG icon. Generates an original, coherent Jobs-era iPhone-style icon family without copying existing app icons.
---

# Local plugin icon

Every local Happy plugin must ship an original PNG icon. Use the available image-generation tool
while authoring the plugin; tests should inspect this skill and fixtures without invoking image
generation.

## Family direction

Create a square, instantly legible app icon inspired by the craft of Jobs-era iPhone icons:

- one confident visual metaphor tied to the plugin's purpose;
- tactile materials, subtle depth, controlled gloss, and a carefully lit focal object;
- a rounded-square composition with generous safe margins and a strong silhouette;
- rich but restrained color, crisp highlights, and readable contrast at 32 px;
- no text, letters, logos, screenshots, UI chrome, mascots from existing products, or copied app
  icons;
- no generic purple gradient, floating geometry, excessive detail, photorealistic clutter, or
  modern flat glyph pasted onto a background.

Keep the family coherent across plugins: frontal three-quarter lighting from the upper left, a
quietly dimensional background, one material accent, and a polished object centered optically.
Vary the metaphor and dominant hue so plugins remain distinguishable.

## Required workflow

1. Read `happy.plugin.json` and the plugin entry to understand the single action the icon should
   symbolize.
2. Write a concise image prompt using the family direction above. State that the image must be
   original and contain no text or third-party marks.
3. Generate one square image. Prefer 1024×1024 so the source survives later resizing.
4. Inspect the result. Regenerate if the metaphor is ambiguous, the silhouette disappears when
   small, the composition contains text, or it resembles a recognizable existing icon.
5. Save the final asset as a real PNG inside the plugin folder, normally `icon.png`, and set the
   manifest's `icon` field to that relative path.
6. Verify the file has the PNG signature and square dimensions. Do not substitute a renamed JPEG,
   SVG, placeholder byte string, or remote URL.

Prefer the available image-generation tool and use the PNG it returns directly.
Only when image generation is unavailable, create the icon another way with sandbox-compatible
image tooling.
Programmatic drawing or an SVG intermediary is acceptable as a fallback, but the finished asset
must still be a polished, original PNG rather than a placeholder. Do not use `qlmanage` inside Rig's
restricted shell: it tries to initialize a nested macOS sandbox, which macOS refuses. Choose another
converter or rendering method and keep going until the required PNG exists.

Do not edit or install anything in the user's global skill directories. This skill is bundled with
Rig and the generated PNG belongs only to the plugin source folder.
