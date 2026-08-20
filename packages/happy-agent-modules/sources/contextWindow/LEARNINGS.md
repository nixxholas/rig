# Context-window learnings

## Check every inference boundary

Automatic compaction uses each model's curated threshold. A persisted measurement is checked when
a turn starts, and every completed inference is checked as soon as the provider reports its exact
input-plus-output size. When a tool-calling response crosses the threshold, all of that response's
tool results settle first; compaction then replaces the context before the continuation request.
