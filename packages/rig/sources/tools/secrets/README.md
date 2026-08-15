# Secret tools

This directory contains model-facing tools for the secrets domain.
`request_secret` prepares a metadata-only final-message attachment that a
client can open as a masked create or update form.

```text
model request
    |
    v
AttachmentContext -- successful turn --> secret_request attachment
    |
    +-------------- aborted/error turn --> discarded
```

Secret values never enter tool arguments, tool results, attachments, or the
transcript. The client submits them through the existing secret registration
API.
