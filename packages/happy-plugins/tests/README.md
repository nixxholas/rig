# Tests

These tests exercise the public SDK against real HTTP servers bound to temporary Unix sockets.
They verify environment-free construction, authentication, request shapes, readable failures, and
the in-memory authoring host's seeded data, provider usage, MCP call loop, and application
resource/action lifecycle, network request handlers, and tunnel observations without Docker.
