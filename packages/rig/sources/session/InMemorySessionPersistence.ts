/**
 * The asynchronous persistence contract consumed by an in-memory session.
 *
 * The implementation remains declared alongside the session because its
 * payloads are session-owned. This module gives stores and integrations a
 * focused import without exposing the session implementation.
 */
export type { InMemorySessionPersistence } from "./InMemorySession.js";
