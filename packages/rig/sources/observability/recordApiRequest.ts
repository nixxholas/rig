import { metrics, type Counter, type Histogram } from "@opentelemetry/api";

let requests: Counter | undefined;
let duration: Histogram | undefined;

export function recordApiRequest(
    route: string,
    method: string,
    statusCode: number,
    durationMs: number,
): void {
    const meter = metrics.getMeter("rig.daemon");
    requests ??= meter.createCounter("rig_api_requests", {
        description: "Rig protocol API requests",
    });
    duration ??= meter.createHistogram("rig_api_request_duration", {
        description: "Rig protocol API request duration",
        unit: "ms",
    });
    const attributes = {
        "http.request.method": method,
        "http.response.status_code": statusCode,
        "rig.api.route": route,
    };
    requests.add(1, attributes);
    duration.record(durationMs, attributes);
}
