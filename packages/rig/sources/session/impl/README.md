# session/impl

Small helpers the session module uses internally. Nothing here is part of the
module's public shape: read `session/README.md` and the files at the session top
level first, and come here only when one of them sends you.

```
InMemorySession ----> createAbortRequestKey          identity for a pending abort
                 |--> createGoalTitle                one line title for a goal
                 |--> createSessionMetadataTranscript  transcript fed to the titler
                 |--> clampSessionDraftTimestamp     keeps draft clocks sane
                 |--> formatShellCommandContext      shell result as agent context
                 |--> resolveInitialModelSelection   model plus provider at create
                 |--> resolveSharedAgentPath         path another session can use
                 |--> resolveSteeringContinuationMessageIds  what a steer resumes
                 |--> sessionUnreadStateAfterEvent   unread mark after an event
                 |--> isTransientInferenceSessionEvent

SessionEventLog -----> affectsSessionUsage           does this event move usage
isLiveOnlySessionEvent -> isTransientInferenceSessionEvent

latestObservedProviderQuotas  most recent quota per provider from an event list
```

Each file holds one function, and its tests live in `impl/tests`.
