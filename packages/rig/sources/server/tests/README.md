# Server tests

These tests cover the daemon and protocol boundary rather than domain state.
They use the public server constructors and local sockets to exercise request
authentication, HTTP responses, streaming, diagnostics, logs, and lifecycle
cleanup.

```text
tests
 |
 +-- createProtocolHttpServer.*  HTTP routes and failures
 +-- globalEventStream / gitStateHttp
 |                              protocol streaming behavior
 +-- remoteTerminalHttp / httpProxyApi
 |                              external protocol boundaries
 +-- runLocalProtocolServer.*    daemon lifecycle and logging
 +-- DaemonLog / writeDaemonCrashReport
 |                              fatal stacks and private diagnostic reports
 +-- remaining files             focused server helpers
```

Session, project, Git, global-event, and persistence tests live with their
respective modules.
