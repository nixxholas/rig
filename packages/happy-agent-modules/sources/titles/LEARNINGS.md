# Titles — learnings

## Titles follow accepted user-role messages, not transports

The message-accepted transactional hook counts text-bearing messages whose actual message role is
`user`; provenance metadata is irrelevant, so API messages, tool-submitted messages, and other
in-process callers follow one path. The first such message generates a title from that message
alone. The second triggers one refinement from committed history, which already includes the new
user message. Later user messages do not generate title requests.

The hook writes the per-agent counter and snapshots a bounded history excerpt for the second
message before registering post-commit work. Taking that snapshot in the acceptance transaction
keeps a very fast response to the second message out of the refinement input. Inference and
metadata updates then run on a detached module-owned context through an `AsyncResource` created
outside every agent turn. Both boundaries are necessary: detaching the structured context prevents
reuse of a committed database transaction, while the async resource prevents agent-loop
async-local state from making the eventual metadata update look like a self-deadlocking in-turn
mutation. Neither message acceptance nor real inference waits for naming, and the API module has no
title behavior.

Every task rechecks metadata before writing, so a title chosen while it runs always wins. Initial
naming and refinement are serialized per agent, allowing a quickly arriving second user message to
wait for the first title task without delaying the agent itself.

## Placeholder names must remain distinguishable from chosen names

Clients sometimes create a workspace with a temporary display name before its first chat exists.
Workspace creation therefore carries whether the supplied name was deliberately chosen. Omission
means chosen for compatibility; an explicit false keeps the workspace eligible for first-message
naming. Names supplied by the workspace-creation agent tool are deliberate.
