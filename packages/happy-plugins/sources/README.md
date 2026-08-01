# Sources

This directory contains the public plugin types, Unix-socket client, MCP call stream, in-memory
authoring host, and no-Docker development runner. `index.ts` is the package boundary. The fake host
serves the same public request and response schemas as Rig rather than defining a test-only
protocol. It creates a production-shaped writable data directory in a short operating-system
temporary root and removes the root on close. MCP registrations reconnect with bounded backoff
after an unexpected call-stream loss and expose their current status and failure through the public
server handle.
