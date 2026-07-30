# session/usage

Turns a session's events into the totals Rig shows: tokens and cost per model,
how much of the context window a conversation is using, and how much of a
provider's quota the session accounts for.

```
   session events
         |
         v
   aggregateSessionUsage  ------> SessionUsageSummary
         |     |     |                 groups[]           per model and provider
         |     |     |                 context            context window pressure
         |     |     |                 observedQuota      quota contributions
         |     |     |                 sessionTokenCount  counted tokens
         |     |     |
         |     |     +--> aggregateQuotaContributions   quota windows per provider
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

`types.ts` holds the shapes above. `index.ts` is what other modules import.
Aggregation is pure: it reads events and returns a summary, and it never touches
a session, a store or the database.
