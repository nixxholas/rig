# Generated media

Rig owns one host directory for generated images, attachment snapshots, and
video previews.

```text
model path (/happy/generated/file.png)
                    |
                    v
host storage -> generated/file.png -> authenticated HTTP route
```

`GeneratedMediaStore` keeps the host and model paths internal. Persisted
protocol values use `generated/<name>` locators so clients never depend on a
host path or a Docker mount path. The daemon resolves those locators against
the configured generated-media root and verifies the canonical target before
serving it.
