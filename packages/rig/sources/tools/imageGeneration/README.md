# Image generation

This module exposes one provider-neutral image tool whenever the executor has at
least one image-generation capability. The model does not choose an account.

```text
image_gen.imagegen
        |
        v
preferred current provider
        |
        | definitive account refusal only
        v
remaining providers in round-robin order
        |
        v
generated_images/<tool-call>.png
```

Codex cloud providers currently supply the capability. Bedrock does not.
Transport failures and malformed results stop without fallback because the
first request may already have been billed. Edit inputs are prepared
sequentially under aggregate source and encoded-request limits.
