# Auto module — spec learnings

- The history module now records who actually sent each incoming message: an accepted message is
  archived as `role: "user"` only when its metadata carries the positive `messageOrigin: "user"`
  stamp this module trusts, and as `role: "agent"` otherwise, with `senderAgentId` naming the
  specific sending agent when the sender identified itself (collaboration deliveries and goal
  continuations now stamp it via `senderAgentIdMetadata`). Deviation 1 in `SPEC.md` ("v2's
  public history drops provenance") is therefore partially stale: provenance is no longer the
  reason the evidence archive exists. The archive is still needed for the human-owned portion of
  interactive answers, generation stamping tied to compaction, fail-closed archive health, and
  the exact trusted/untrusted classification — propose updating the deviation's rationale in
  `SPEC.md` rather than removing the archive.
- `senderAgentId` is attribution, never authorization. The reviewer's trust decision must keep
  resting solely on the positive `messageOrigin: "user"` stamp; a sender ID grants nothing.
