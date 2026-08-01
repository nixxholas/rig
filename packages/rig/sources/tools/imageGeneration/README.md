# Image generation

This module exposes one image tool whenever the executor has at least one
image-generation capability. The model does not choose an account.

```text
codex_imagegen (Codex models)   imagegen (every other family)
                    \             /
                     v           v
              preferred current provider
                          |
                          | definitive account refusal only
                          v
             remaining providers in round-robin order
                          |
                          v
              generated_images/<tool-call>.png
```

One implementation sits behind both names. `selectToolsForModel` picks the
surface, so a model family gets the wording its training expects while
execution, permissions, and persistence stay identical.

Neither surface is namespaced, and Codex models deliberately do not see a tool
called `imagegen`: the Responses API reserves both the `image_gen` namespace and
that tool name for its own built-in image tool, and rejects the whole request
when a definition under either differs from the built-in one. Both surfaces also
accept an explicit `null` for an unused image selector, which Codex models emit
in place of omitting the field.

Codex cloud providers currently supply the capability. Bedrock does not.
Transport failures and malformed results stop without fallback because the
first request may already have been billed. Edit inputs are prepared
sequentially under aggregate source and encoded-request limits.
