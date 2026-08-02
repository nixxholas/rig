# Sources

This directory contains the public plugin types, Unix-socket client, MCP stream, in-memory
authoring host, and no-Docker development runner. `index.ts` is the package boundary. Apps are
manifest-declared static folders rather than an SDK lifecycle. The fake host mirrors projects,
workspace commands and bounded files, sessions, provider usage, MCP calls, app-scoped MCP calls,
and plugin-private storage.
Workspace command execution, path resolution, and file access are one shared implementation used
by both the fake host and Rig through the package's internal host export.
It enforces the same tool visibility, JSON/key/value/count/quota rules, and manifest bundle
validation as Rig.
It creates a production-shaped writable data directory in a short operating-system temporary root
and removes the root on close. MCP registrations reconnect with bounded backoff after a stream loss.
