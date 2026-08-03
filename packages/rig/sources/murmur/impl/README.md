# Murmur implementation details

This directory contains the mechanical codecs and image normalization used by
the Murmur domain service.

```text
HTTP profile data
      |
photoNormalize.ts -> bounded 512px WebP + ThumbHash
      |
murmurCodec.ts -> native Murmur profile and durable TypeBox-checked records
```

Secret identity seeds are encoded only in the durable account record. Temporary
decoded seeds and copied avatar bytes are overwritten after use.
