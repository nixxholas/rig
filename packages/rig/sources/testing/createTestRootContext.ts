import {
    createRootContext,
    withLogger,
    withTracer,
    type Logger,
    type RootContext,
    type TraceSpan,
    type Tracer as StdlibTracer,
} from "@steve.kite/stdlib";
import { ROOT_CONTEXT, trace, type Span, type Tracer } from "@opentelemetry/api";

import { initializeDaemonContext } from "../observability/index.js";

/** Creates a daemon-shaped root context without writing test logs. */
export function createTestRootContext(tracer?: Tracer): RootContext {
    const logger = silentLogger();
    if (tracer === undefined) {
        initializeDaemonContext(logger);
        return withLogger(createRootContext(), logger);
    }
    initializeDaemonContext(logger, tracer);
    return withTracer(withLogger(createRootContext(), logger), new TestTracerAdapter(tracer));
}

class TestTracerAdapter implements StdlibTracer {
    constructor(private readonly tracer: Tracer) {}

    startSpan(name: string, parent: TraceSpan | undefined): TraceSpan {
        const parentContext =
            parent instanceof TestTraceSpan
                ? trace.setSpan(ROOT_CONTEXT, parent.span)
                : ROOT_CONTEXT;
        return new TestTraceSpan(this.tracer.startSpan(name, undefined, parentContext));
    }
}

class TestTraceSpan implements TraceSpan {
    constructor(readonly span: Span) {}

    recordException(error: unknown): void {
        this.span.recordException(error instanceof Error ? error : String(error));
    }

    end(): void {
        this.span.end();
    }
}

function silentLogger(): Logger {
    const write = () => undefined;
    return { debug: write, error: write, fatal: write, info: write, trace: write, warn: write };
}
