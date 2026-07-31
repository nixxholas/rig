/**
 * The durable lifecycle events a timeline is made of.
 *
 * Every other session event is ignored by the fold, and the persistence query
 * narrows to exactly these before reading any payload, so a chart never loads
 * the history it does not draw.
 */
export const TIMELINE_EVENT_TYPES = [
    "message_submitted",
    "run_error",
    "run_finished",
    "run_started",
    "user_input_requested",
    "user_input_resolved",
] as const;

export function isTimelineEventType(type: string): boolean {
    return (TIMELINE_EVENT_TYPES as readonly string[]).includes(type);
}
