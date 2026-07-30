# Global event tests

These tests exercise the public behavior of the global-event module.

```text
tests
  |
  +--> queue ordering and replay windows
  +--> durable append rollback
  +--> stored versus live classification
  +--> session-store fan-out
  +--> UUIDv7 cursor parsing
```

HTTP stream behavior is currently covered by `server/tests/globalEventStream.test.ts`
and `server/tests/gitStateHttp.test.ts` because framing, connection lifecycle, and
backpressure belong to the server boundary.
