# Built-in tool tests

These tests cover what each built-in tool says about itself when a session is
shared: the sentence its `toSharedCall` writes about the action, the sentence
its `toSharedResult` writes about the outcome, and whether it declared its raw
output disclosable at all.

```
tool arguments ──► toSharedCall ──┐
                                  ├──► one English sentence
tool result    ──► toSharedResult ┘
                                  └──► must not contain the payload
```

Every case asserts two things at once: that the sentence is accurate and
readable enough for a friend to follow the work, and that it does not carry the
thing the sharing boundary exists to hold back. The payload cases embed a
recognisable fake credential in the tool's result and assert the summary does
not reproduce it, so a summary that starts interpolating output fails here
rather than in someone else's replicated transcript.

Failures are covered alongside successes because a shared transcript has to stay
legible when a command exits non-zero, a fetch returns an error status, or a
patch does not apply.
