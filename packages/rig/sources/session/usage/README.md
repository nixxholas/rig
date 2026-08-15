# session/usage

Turns a session's events into the totals Rig shows: tokens and cost per model,
and how much of the context window a conversation is using.

```
   session events
         |
         v
   aggregateSessionUsage  ------> SessionUsageSummary
         |     |                       groups[]           per model and provider
         |     |                       context            context window pressure
         |     |                       sessionTokenCount  counted tokens
         |     |
         |     +--------> addUsage                      adds two Usage records
         +--------------> zeroUsage                     an empty Usage record

   session events ------> aggregateSessionTokenCount
                              |
                              v
                    sessionTokenCountAfterEvent
                              |
                              v
                    updateSessionTokenCount
```

`addUsage` and `zeroUsage` are the arithmetic everything else builds on, and they
are used outside this module too: a permission review agent accumulates its own
usage the same way, so its tokens can be attributed separately from the
conversation that triggered the review.

The provider-neutral `get_agent_tree_usage` common tool reports exact lifetime
usage for its current session subtree. A dedicated durable counter survives
conversation reset without changing the reset-scoped usage shown by the ordinary
session UI. Persistent stores walk indexed hidden-subagent and visible-delegation
branches directly in SQLite; the in-memory store builds the same bounded tree
from its live session registry.

Completed descendants remain visible after restart, unrelated sessions and caller
ancestors are excluded, and each session contributes its lifetime counter once.
Permission-review tokens stay attributed to their owning session and are not
counted again from the summary breakdown. Rows include stable session and agent
IDs plus available titles, task names, and descriptions. Traversal is
deterministically ordered and returns an error instead of a partial total if a
tree exceeds 10,000 sessions.

`types.ts` holds the shapes above. `index.ts` is what other modules import.
Aggregation is pure: it reads events and returns a summary, and it never touches
a session, a store or the database.
