# Sources

This directory contains the public plugin types, Unix-socket client, MCP and application action
streams, in-memory authoring host, and no-Docker development runner. `index.ts` is the package
boundary. The fake host serves the same projects, workspaces, sessions, provider usage, MCP, and UI
schemas as Rig instead of defining a test-only protocol. It creates a production-shaped writable
data directory in a short operating-system temporary root and removes the root on close. MCP and
application registrations reconnect with bounded backoff after an unexpected stream loss.
