import {
    eventIdsShareScope,
    type EventId,
    type SessionPermissionReview,
    type SessionEvent,
    type ShellCommandState,
} from "../protocol/index.js";
import { isLiveOnlySessionEvent } from "./isLiveOnlySessionEvent.js";
import type { ProviderQuota } from "@slopus/rig-providers";
import { affectsSessionUsage } from "./affectsSessionUsage.js";

export type SessionEventListener = (event: SessionEvent) => void;
export type SessionEventAppendHook = (event: SessionEvent) => void;
const SESSION_EVENT_RETENTION_LIMIT = 4_096;

export class SessionEventLog {
    #events: SessionEvent[] = [];
    #eventIndexes = new Map<EventId, number>();
    #eventStartIndex = 0;
    #nextEventIndex = 0;
    #firstEventId: EventId | undefined;
    #lastEventId: EventId | undefined;
    #listeners = new Set<SessionEventListener>();
    #messageCreatedAt = new Map<string, number>();
    #messageEventId = new Map<string, EventId>();
    #permissionReviews = new Map<string, SessionPermissionReview>();
    #permissionReviewEventIds = new Map<string, EventId>();
    #messageSubmissions = new Map<string, SessionEvent & { type: "message_submitted" }>();
    #providerQuotas = new Map<string, ProviderQuota>();
    #shellCommands = new Map<string, ShellCommandState>();
    #onAppend: SessionEventAppendHook | undefined;
    #retentionLimit: number;
    #revision = 0;
    #usageRevision = 0;

    constructor(
        options: {
            events?: readonly SessionEvent[];
            lastEventId?: EventId;
            onAppend?: SessionEventAppendHook;
            retentionLimit?: number;
        } = {},
    ) {
        this.#retentionLimit = options.retentionLimit ?? SESSION_EVENT_RETENTION_LIMIT;
        this.#events = [...(options.events ?? [])]
            .filter((event) => !isLiveOnlySessionEvent(event))
            .slice(-this.#retentionLimit);
        for (const [index, event] of this.#events.entries()) {
            this.#eventIndexes.set(event.id, index);
            if (event.type === "message_submitted") {
                this.#messageSubmissions.set(event.data.message.id, event);
            }
            this.#recordMessageTime(event);
            this.#recordPermissionReview(event);
            this.#recordCurrentState(event);
        }
        this.#nextEventIndex = this.#events.length;
        this.#firstEventId = this.#events.at(0)?.id;
        this.#lastEventId = options.lastEventId ?? this.#events.at(-1)?.id;
        this.#onAppend = options.onAppend;
    }

    append(event: SessionEvent): SessionEvent {
        this.#onAppend?.(event);
        if (!isLiveOnlySessionEvent(event)) {
            this.#eventIndexes.set(event.id, this.#nextEventIndex);
            this.#nextEventIndex += 1;
            this.#events.push(event);
            this.#firstEventId ??= event.id;
            if (event.type === "message_submitted") {
                this.#messageSubmissions.set(event.data.message.id, event);
            }
            this.#recordMessageTime(event);
            this.#recordPermissionReview(event);
            this.#recordCurrentState(event);
            if (this.#events.length > this.#retentionLimit) {
                const removed = this.#events.shift();
                if (removed !== undefined) {
                    this.#eventIndexes.delete(removed.id);
                    this.#forgetEventIndexes(removed);
                }
                this.#eventStartIndex += 1;
                this.#firstEventId = this.#events[0]?.id;
            }
        }
        this.#revision += 1;
        if (affectsSessionUsage(event)) this.#usageRevision += 1;
        this.#lastEventId = event.id;
        for (const listener of this.#listeners) {
            try {
                listener(event);
            } catch {
                // Subscribers are optional observers. A disconnected or broken
                // consumer must not roll back an event that is already durable.
            }
        }
        return event;
    }

    firstCreatedAt(): number | undefined {
        return this.#events.at(0)?.createdAt;
    }

    firstMessageCreatedAt(): number | undefined {
        return this.#events.find((event) => event.type === "message_submitted")?.createdAt;
    }

    lastEventId(): EventId | undefined {
        return this.#lastEventId;
    }

    lastCreatedAt(): number | undefined {
        return this.#events.at(-1)?.createdAt;
    }

    messageSubmission(
        messageId: string,
    ): (SessionEvent & { type: "message_submitted" }) | undefined {
        return this.#messageSubmissions.get(messageId);
    }

    messageCreatedAt(messageId: string): number | undefined {
        return this.#messageCreatedAt.get(messageId);
    }

    messageEventId(messageId: string): EventId | undefined {
        return this.#messageEventId.get(messageId);
    }

    permissionReviews(toolCallIds: ReadonlySet<string>): SessionPermissionReview[] {
        return [...toolCallIds].flatMap((toolCallId) => {
            const review = this.#permissionReviews.get(toolCallId);
            return review === undefined ? [] : [review];
        });
    }

    /**
     * Read-only live view for synchronous in-process reducers.
     *
     * `since(undefined)` intentionally returns a defensive copy for protocol
     * callers. Server-owned reducers already cannot mutate this type and may
     * process very long logs, so copying the complete array first is pure cost.
     */
    all(): readonly SessionEvent[] {
        return this.#events;
    }

    latestProviderQuotas(): ReadonlyMap<string, ProviderQuota> {
        return this.#providerQuotas;
    }

    revision(): number {
        return this.#revision;
    }

    usageRevision(): number {
        return this.#usageRevision;
    }

    shellCommandStates(): readonly ShellCommandState[] {
        return [...this.#shellCommands.values()];
    }

    since(eventId: EventId | undefined): readonly SessionEvent[] | undefined {
        if (eventId === undefined || eventId.length === 0) {
            return [...this.#events];
        }

        const index = this.#eventIndexes.get(eventId);
        if (index !== undefined) {
            return this.#events.slice(index - this.#eventStartIndex + 1);
        }

        if (
            this.#firstEventId === undefined ||
            this.#lastEventId === undefined ||
            eventId < this.#firstEventId ||
            eventId > this.#lastEventId ||
            !eventIdsShareScope(eventId, this.#lastEventId)
        ) {
            return undefined;
        }
        let low = 0;
        let high = this.#events.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if ((this.#events[middle]?.id ?? eventId) <= eventId) low = middle + 1;
            else high = middle;
        }
        return this.#events.slice(low);
    }

    subscribe(listener: SessionEventListener): () => void {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    #recordMessageTime(event: SessionEvent): void {
        if (event.type !== "message_submitted" && event.type !== "agent_message") return;
        if (!this.#messageCreatedAt.has(event.data.message.id)) {
            this.#messageCreatedAt.set(event.data.message.id, event.createdAt);
            this.#messageEventId.set(event.data.message.id, event.id);
        }
    }

    #recordPermissionReview(event: SessionEvent): void {
        if (event.type === "session_reset") {
            this.#permissionReviews.clear();
            this.#permissionReviewEventIds.clear();
            return;
        }
        if (event.type !== "agent_event" || event.data.event.type !== "permission_review") return;
        const review = event.data.event;
        this.#permissionReviews.set(review.toolCallId, {
            action: review.action,
            decision: review.decision,
            reason: review.reason,
            risk: review.risk,
            toolCallId: review.toolCallId,
            userAuthorization: review.userAuthorization,
        });
        this.#permissionReviewEventIds.set(review.toolCallId, event.id);
    }

    #forgetEventIndexes(event: SessionEvent): void {
        if (event.type === "message_submitted" || event.type === "agent_message") {
            const messageId = event.data.message.id;
            if (
                event.type === "message_submitted" &&
                this.#messageSubmissions.get(messageId)?.id === event.id
            ) {
                this.#messageSubmissions.delete(messageId);
            }
            if (this.#messageEventId.get(messageId) === event.id) {
                this.#messageCreatedAt.delete(messageId);
                this.#messageEventId.delete(messageId);
            }
        }
        if (event.type === "agent_event" && event.data.event.type === "permission_review") {
            const toolCallId = event.data.event.toolCallId;
            if (this.#permissionReviewEventIds.get(toolCallId) === event.id) {
                this.#permissionReviews.delete(toolCallId);
                this.#permissionReviewEventIds.delete(toolCallId);
            }
        }
    }

    #recordCurrentState(event: SessionEvent): void {
        if (event.type === "provider_quota_observed") {
            const known = this.#providerQuotas.get(event.data.providerId);
            if (known === undefined || event.data.quota.capturedAt >= known.capturedAt) {
                this.#providerQuotas.set(event.data.providerId, event.data.quota);
            }
            return;
        }
        if (event.type === "shell_command_started") {
            this.#shellCommands.set(event.data.commandId, {
                ...event.data,
                status: "running",
            });
        } else if (event.type === "shell_command_finished") {
            this.#shellCommands.set(event.data.commandId, {
                ...event.data,
                status: "finished",
            });
        } else {
            return;
        }
        while (this.#shellCommands.size > 100) {
            const oldest = this.#shellCommands.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            this.#shellCommands.delete(oldest);
        }
    }
}
