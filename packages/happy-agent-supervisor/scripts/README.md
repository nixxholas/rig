# Packaging scripts

`package.mjs` follows the native npm layout used by Rig Code Mode: platform
packages carry one binary and checksum, while the root package carries the
TypeScript API and optional dependencies selecting all four variants.
