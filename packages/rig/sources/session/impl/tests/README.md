# session/impl/tests

Unit tests for the helpers in `session/impl`. Each file tests the helper of the
same name, in isolation and without a database or a running session.

```
clampSessionDraftTimestamp.test.ts          draft clock clamping
createSessionMetadataTranscript.test.ts     transcript given to the titler
formatShellCommandContext.test.ts           shell result formatting and limits
isTransientInferenceSessionEvent.test.ts    which events are transient
latestObservedProviderQuotas.test.ts        newest quota wins per provider
resolveSteeringContinuationMessageIds.test.ts  which messages a steer resumes
sessionUnreadStateAfterEvent.test.ts        unread mark transitions
```

Behavior that spans a whole session, a store or the database belongs in
`session/tests` instead.
