# Abort

Immediately aborts an agent's current run and every current run below it.

```ts
const abort = new AbortModule();
await abort.abort(ctx, agentId);
```

The module reads the complete descendant tree from the agent collection and asks Agent Base to
abort each identity while one `ctx.inTx` transaction is active:

```text
target ──> child ──> grandchild
   │          │           │
   └──────────┴───────────┴── abort signals issued together at commit
```

If ancestry traversal or any abort request fails, the transaction rolls back and no abort signal is
issued. On commit, every signal is issued immediately. The operation never waits for an agent loop,
provider, tool, or descendant to finish settling. Nested callers reuse their transaction, so the
operation composes with API and tool mutations without an early commit.

The traversal is breadth-first, rejects cycles or duplicate identities, and refuses a chain larger
than `MAX_ABORT_CHAIN_AGENTS` rather than consuming unbounded memory. The module owns no tools,
tables, migrations, events, or persistent state. API and collaboration modules call its public
`abort` operation.
