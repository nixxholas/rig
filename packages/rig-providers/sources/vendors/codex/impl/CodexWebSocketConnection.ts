import type OpenAI from "openai";
import type {
    ResponseOutputItem,
    ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import { ResponsesWS } from "openai/resources/responses/ws";

import type { SessionTool } from "@/core/SessionTool.js";
import type { CodexResponseRequest } from "@/vendors/codex/impl/CodexResponseRequest.js";
import type { CodexTurnState } from "@/vendors/codex/impl/CodexTurnState.js";
import { createCodexCliWarmupRequest } from "@/vendors/codex/impl/createCodexCliRequest.js";
import { createCodexCliSseRequest } from "@/vendors/codex/impl/createCodexCliSseRequest.js";
import { createCodexCliWebSocketInferenceRequest } from "@/vendors/codex/impl/createCodexCliWebSocketInferenceRequest.js";
import { createCodexWebSocketStream } from "@/vendors/codex/impl/createCodexWebSocketStream.js";
import { getCodexIncrementalInput } from "@/vendors/codex/impl/getCodexIncrementalInput.js";
import { withCodexStreamIdleTimeout } from "@/vendors/codex/impl/withCodexStreamIdleTimeout.js";

/**
 * The Codex WebSocket, which is a conversation rather than a request.
 *
 * The socket is warmed once, and every later turn may send only what changed since the response
 * it continues from. That makes the response chain — the last request, its output, and its id —
 * the state that decides whether the next turn can be incremental, so it lives here with the
 * socket it describes. The chain is single-use: building an incremental request consumes it, and
 * anything that interrupts the exchange discards it so the next turn replays in full.
 */
export class CodexWebSocketConnection {
    private socket: ResponsesWS | undefined;
    private started = false;
    private inferenceStarted = false;
    private needsFullRequest = false;
    private previousRequest: CodexResponseRequest | undefined;
    private previousResponseId: string | undefined;
    private previousResponseItems: readonly ResponseOutputItem[] = [];

    constructor(
        private readonly options: {
            client: () => OpenAI;
            headers: () => Record<string, string>;
            idleTimeoutMs: number;
            turnState: CodexTurnState;
        },
    ) {}

    async *stream(options: {
        request: CodexResponseRequest;
        signal?: AbortSignal;
        tools: readonly SessionTool[];
    }): AsyncGenerator<ResponseStreamEvent> {
        const { request, signal, tools } = options;
        const turnState = this.options.turnState;
        const client = this.options.client();
        this.socket ??= new ResponsesWS(client, { headers: this.options.headers() });
        if (!this.started) {
            for await (const event of this.send(
                client,
                createCodexCliWarmupRequest(request, tools),
                signal,
            )) {
                turnState.observe(event);
                if (event.type === "response.completed")
                    this.previousResponseId = event.response.id;
            }
            this.started = true;
        }
        const fullRequest = request;
        const incrementalInput =
            this.previousRequest === undefined
                ? undefined
                : getCodexIncrementalInput(
                      this.previousRequest,
                      this.previousResponseItems,
                      fullRequest,
                  );
        const canContinue =
            !this.needsFullRequest && (!this.inferenceStarted || incrementalInput !== undefined);
        // Codex builds a separate ResponseCreateWsRequest from its durable request. Keep the same
        // ownership boundary even when a request-shaping helper has no transformations to apply.
        const inferenceRequest = structuredClone(
            canContinue
                ? createCodexCliWebSocketInferenceRequest(request)
                : createCodexCliSseRequest(request, tools),
        );
        if (incrementalInput !== undefined) inferenceRequest.input = incrementalInput;
        if (canContinue && this.previousResponseId !== undefined) {
            inferenceRequest.previous_response_id = this.previousResponseId;
        }
        // Match Codex's LastResponse::take() behavior: a response chain is single-use once an
        // incremental request is constructed. Any retry must rebuild complete durable context.
        this.clearResponseChain();
        this.inferenceStarted = true;
        this.needsFullRequest = false;
        for await (const event of this.send(client, inferenceRequest, signal)) {
            turnState.observe(event);
            if (event.type === "response.completed") {
                this.previousResponseId = event.response.id;
                this.previousRequest = structuredClone(fullRequest);
                this.previousResponseItems = structuredClone(event.response.output ?? []);
            }
            yield event;
        }
    }

    /** Drops the chain while leaving the socket warm, as compaction does. */
    clearResponseChain(): void {
        this.previousRequest = undefined;
        this.previousResponseId = undefined;
        this.previousResponseItems = [];
    }

    /** Abandons the exchange but remembers it was warmed, so the next turn replays in full. */
    reset(reason: string): void {
        this.needsFullRequest = this.started;
        this.close(reason);
        this.clearResponseChain();
        this.inferenceStarted = false;
    }

    /** Forgets everything, for when the credential behind the socket is no longer the same. */
    discard(reason: string): void {
        this.close(reason);
        this.clearResponseChain();
        this.inferenceStarted = false;
        this.started = false;
        this.needsFullRequest = false;
    }

    close(reason: string): void {
        if (this.socket?.socket.readyState !== undefined && this.socket.socket.readyState < 2)
            this.socket.close({ code: 1000, reason });
        this.socket = undefined;
    }

    private send(
        client: OpenAI,
        request: CodexResponseRequest,
        signal: AbortSignal | undefined,
    ): AsyncIterable<ResponseStreamEvent> {
        const socket = this.socket;
        if (socket === undefined) {
            throw new Error("The Codex WebSocket closed before the request could be sent.");
        }
        const turnState = this.options.turnState.value;
        return withCodexStreamIdleTimeout({
            stream: createCodexWebSocketStream({
                client,
                request,
                socket,
                ...(signal === undefined ? {} : { signal }),
                ...(turnState === undefined ? {} : { turnState }),
            }),
            timeoutMs: this.options.idleTimeoutMs,
            ...(signal === undefined ? {} : { signal }),
            onTimeout: () => this.close("stream idle timeout"),
        });
    }
}
