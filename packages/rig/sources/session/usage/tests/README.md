# session/usage/tests

Tests for usage aggregation and token counting. They exercise pure values and
event lists, so they run without a session, a store or a database.

```
aggregateSessionUsage.test.ts        grouping, cost, context and subagents
updateSessionTokenCount.test.ts       context growth, compaction and reset
```
