# Sources

This directory contains the public plugin types, Unix-socket client, MCP stream, in-memory
authoring host, and no-Docker development runner. `index.ts` is the package boundary. Apps are
manifest-declared static folders rather than an SDK lifecycle. The fake host mirrors projects,
workspaces, sessions, provider usage, MCP calls, app-scoped MCP calls, and plugin-private storage.
It enforces the same tool visibility, JSON/key/value/count/quota rules, and manifest bundle
validation as Rig.
It creates a production-shaped writable data directory in a short operating-system temporary root
and removes the root on close. MCP registrations reconnect with bounded backoff after a stream loss.
