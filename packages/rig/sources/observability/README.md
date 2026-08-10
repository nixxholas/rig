# Observability

This module starts the daemon's OpenTelemetry SDK. It exposes Prometheus metrics
on loopback at `http://127.0.0.1:9464/metrics` and sends OTLP/HTTP traces to
`http://127.0.0.1:4318/v1/traces` by default.

```text
Rig daemon --metrics--> Prometheus
     |
     +--OTLP traces--> OpenTelemetry Collector --> Tempo --> Grafana
```

Set `RIG_METRICS_HOST`, `RIG_METRICS_PORT`, or `RIG_OTEL_TRACES_ENDPOINT` to
override the local defaults.
