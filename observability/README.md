# Local observability

Run `pnpm observability:up` to start the local collector and viewers. Then run
Rig normally. Open Grafana at [http://localhost:3000](http://localhost:3000)
(default login: `admin` / `admin`), or Prometheus at
[http://localhost:9090](http://localhost:9090).

Rig publishes metrics at `http://127.0.0.1:9464/metrics` and traces to the
collector's OTLP/HTTP endpoint at `http://127.0.0.1:4318/v1/traces`.

Long-lived event streams are excluded by Rig itself because their lifetime does not
describe request latency. Every bounded request and its child spans are retained by
the collector so an `x-rig-trace-id` response header can always be resolved in Tempo.
