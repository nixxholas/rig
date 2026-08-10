import { randomUUID } from "node:crypto";

import { metrics, type Tracer } from "@opentelemetry/api";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
    ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
    ATTR_SERVICE_INSTANCE_ID,
    ATTR_SERVICE_NAME,
    ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const DEFAULT_METRICS_HOST = "127.0.0.1";
const DEFAULT_METRICS_PORT = 9464;
const DEFAULT_TRACES_ENDPOINT = "http://127.0.0.1:4318/v1/traces";
const TRACE_EXPORT_DELAY_MS = 100;
const TRACE_EXPORT_BATCH_SIZE = 4_096;
const TRACE_EXPORT_QUEUE_SIZE = 65_536;
const portSchema = Type.Integer({ maximum: 65_535, minimum: 1 });

export interface ObservabilityService {
    readonly tracer: Tracer;
    shutdown(): Promise<void>;
}

/** Starts the local daemon telemetry SDK. Prometheus is loopback-only. */
export function startObservability(
    environment: NodeJS.ProcessEnv = process.env,
): ObservabilityService {
    const metricsHost = environment.RIG_METRICS_HOST ?? DEFAULT_METRICS_HOST;
    const metricsPort = parsePort(environment.RIG_METRICS_PORT, DEFAULT_METRICS_PORT);
    const tracesEndpoint = environment.RIG_OTEL_TRACES_ENDPOINT ?? DEFAULT_TRACES_ENDPOINT;
    const resource = resourceFromAttributes({
        [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: environment.RIG_RUNTIME_MODE ?? "production",
        [ATTR_SERVICE_NAME]: "rig",
        [ATTR_SERVICE_INSTANCE_ID]: randomUUID(),
        [ATTR_SERVICE_VERSION]: environment.npm_package_version ?? "development",
    });
    const tracerProvider = new NodeTracerProvider({
        resource,
        spanProcessors: [
            new BatchSpanProcessor(new OTLPTraceExporter({ url: tracesEndpoint }), {
                // Session restoration can create hundreds of short SQL spans per second. The
                // OpenTelemetry defaults drain too slowly and drop the request root, which ends
                // after its children. Keep the buffer bounded while exporting frequently enough
                // to preserve complete traces under startup load.
                maxExportBatchSize: TRACE_EXPORT_BATCH_SIZE,
                maxQueueSize: TRACE_EXPORT_QUEUE_SIZE,
                scheduledDelayMillis: TRACE_EXPORT_DELAY_MS,
            }),
        ],
    });
    const tracer = tracerProvider.getTracer("rig.daemon");
    const sdk = new NodeSDK({
        metricReader: new PrometheusExporter({ host: metricsHost, port: metricsPort }),
        resource,
        // Rig contexts own an explicit provider. Do not compete with libraries
        // that may already have registered a process-global tracer provider.
        spanProcessors: [],
    });
    sdk.start();
    metrics.getMeter("rig.daemon").createCounter("rig_daemon_starts_total").add(1);
    tracer.startSpan("rig.daemon.start").end();

    return {
        tracer,
        shutdown: async () => {
            // Telemetry is optional: an unavailable local collector must not
            // turn an otherwise clean daemon shutdown into a failure.
            await Promise.allSettled([sdk.shutdown(), tracerProvider.shutdown()]);
        },
    };
}

function parsePort(value: string | undefined, fallback: number): number {
    if (value === undefined) return fallback;
    const port = Number(value);
    return Value.Check(portSchema, port) ? port : fallback;
}
