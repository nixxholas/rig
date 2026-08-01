# Tests

These tests exercise the public SDK against real HTTP servers bound to temporary Unix sockets.
They verify environment-free construction, authentication, request shapes, readable failures, and
the in-memory authoring host's seeded data and MCP call loop without Docker.
