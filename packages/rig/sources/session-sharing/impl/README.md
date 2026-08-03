# Session sharing internals

What a friend actually receives. `projectSessionShareEntry.ts` one level up is
the public shape; this directory is the rule that decides, field by field, what
a replicated transcript is allowed to say.

The rule is an allowlist, and it is an allowlist because a share is a privacy
boundary. Nothing here removes known-bad fields from a payload; every file
builds a fresh object out of fields it names on purpose. Anything nobody named —
a message role added next year, an event type from another module, a tool this
build has never seen — produces less, and in the limit produces nothing.

```
  session event ─────► shareProjectEvent ──┐
                            │              │
                            │ agent_message│
                            ▼              ▼
  transcript message ──► shareProjectMessage ──► shareProjectToolBlock
                            │                        │
                            └────► shareReadValue ◄──┘
                                   (typed readers)
```

- `shareProjectEvent.ts` rebuilds one session event. A `switch` over the event
  type with a `default` that returns nothing: a new event type replicates only
  once somebody decides what it means to hand it to another person. It is also
  where payload likes to hide — a finished shell command carries its output, a
  reset carries the whole transcript, a permission review carries the reasoning
  it reviewed — so those fields are dropped by name with a comment saying why.
- `shareProjectMessage.ts` rebuilds one transcript message per role. Text and
  images the people and the agent wrote each other replicate whole, because they
  are the conversation. Provider-native fields do not: signed reasoning blobs,
  replayed response items, compaction's replacement context, attachment paths on
  the owner's disk.
- `shareProjectToolBlock.ts` is the tool boundary itself, described below.
- `shareReadValue.ts` holds the typed readers everything else uses. They exist
  so the projection never trusts the shape of what it parsed out of the
  database: a field that is not a string does not become one, and a field of an
  unexpected type is simply absent from the result.

## The tool boundary

A friend learns what the agent did, not what the agent saw.

```
  tool_call  ──►  { type, id, name, summary }
  tool_result ─►  { type, toolCallId, toolName, summary, isError?, failure.kind? }

  raw arguments, display, rendered, failure.message
        ▲
        └── crosses only when  tool.sharedOutputDisclosable === true
                                AND  share.toolOutput === "full"
```

Both keys are required and they are turned by different people. The tool
definition decides whether its payload is the kind of thing an owner may choose
to disclose at all; the owner decides whether this particular share discloses.
That is what stops a sensitive-by-nature result from becoming shareable by
clicking through a single switch.

Nothing here looks at a tool's name, prefix, or provider. The summary sentence
and the disclosure flag were written by the tool definition itself and recorded
on the block when the call ran — see `../../agent/SharedToolActivity.ts`. This
code only reads what is there. A block carrying neither is a tool this
projection cannot describe, and it becomes the smallest honest row rather than a
passthrough, which is what keeps the boundary correct for MCP tools, plugin
tools, and tools that do not exist yet.

Failures stay legible, because watching someone debug is most of the reason to
share. The outcome always replicates, as a sentence. The failure's _message_
does not, because that message is usually the text the failing command printed.

Two things that look like descriptions are payload in disguise, and both are
dropped here rather than in the tools that produce them. A permission review's
`action` is built out of the tool's own raw arguments — the keystrokes, the whole
command line and the owner's absolute working directory — and its `reason` is
prose from a reviewer that had just read all of it; the tool call beside the
review already carries the sentence its own definition wrote. And a command the
user ran themselves is stored as a user message whose blocks are the command's
stdout and stderr, so `shareProjectMessage` drops that message and lets the
`shell_command_finished` event speak for it.

Free-form text from a model or a provider — a run's error message, a
compaction's — does replicate, because a failure nobody can read is not a shared
session. It goes through `shareExplanation`, which keeps it to the length of an
explanation: a long one is usually long because something got echoed back into
it.
