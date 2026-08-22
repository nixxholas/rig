# Duty module

`DutyModule` binds a durable Rig agent to one machine-issued charter. Bindings, runs, alarms, and
replacement are local Rig state. An unbound root session may control that state through ordinary
agent tools, so any existing chat transport can act as the console without knowing what a Duty is.

```text
Happy/Config/duties.toml   <- the machine's roster, read on every start
    | reconcile (idempotent)
    v
machine issuer
    | issueDuty / activateDuty / changeDutyStatus
    v
durable binding + run -- AgentSystemRef.send --> bound Rig agent
    |    ^                                        |
    |    +-- own interval alarm                   +-- instructions
    |                                             +-- allowed-tool enforcement
    +<------------ settlement hook ---------------+
```

One module instance serves every agent. Bindings and run records live in module-owned database
tables and survive process restarts. Wake messages are agent-originated and carry no human
authority. Duty holders receive only `get_duty` from this module. Unbound root sessions additionally
receive `issue_duty`, `list_duties`, `activate_duty`, and `set_duty_status`, so a holder cannot
promote or replace itself. Issuance and permanent stop use the normal permission-review path in
auto mode.

`issue_duty` creates a dedicated durable holder instead of binding the control session. Repeating
the same declaration is idempotent. A new tenure stops the current holder and creates a fresh one
without inherited conversation history; this is the replacement path when a holder is no longer
performing. Interactively issued bindings survive restart and are not pruned by an empty roster.

When Rig is connected to Happy, it may additionally register `duty-issue`, `duty-activate`,
`duty-status`, `duty-pause`, `duty-resume`, and `duty-stop` as machine-local RPC methods. They use
Happy's existing encrypted namespaced machine relay, so an unchanged Happy server and existing
Happy clients continue to use `spawn-happy-session` exactly as before. The methods are available
only on a Rig machine; they do not add an HTTP route or change Happy's deployed app protocol.

## The roster

A Duty is declared in `duties.toml` beside `happy.toml` in the config home — the same folder that
already holds `AGENTS.md` and `SECURITY.md`. That folder is machine-scoped, so a file checked into a
repository an agent works on cannot issue a Duty or widen one.

```toml
[[duty]]
id = "release-warden"
charter = "Keep the release branch green: watch CI, and report what broke it."
trigger = "Sweep the branch."
project = "/srv/repo"              # absolute; the folder the Duty works in
permission_ceiling = "workspace_write"
allowed_tools = ["read_file", "search_files", "shell"]
every = "30m"                      # optional; 1 minute to 24 hours
tenure = "tenure-1"                # optional; naming a new one hands the role on
```

Reconciliation runs on every start and is idempotent. An identical declaration keeps its current
holder and any run in flight. Changing the charter, tools, permission ceiling, trigger, or interval
stops the old authority and reissues it. Naming a new `tenure`, or moving the Duty to another
project, creates a fresh holder with no inherited conversation context.

A clean roster is authoritative: removing an entry stops that roster-owned Duty. An unreadable,
malformed, duplicate, truncated, or partially invalid roster is not authoritative, so a typo cannot
silently decommission persisted work. Duties issued directly or through Happy RPC are outside the
roster and are never pruned by it.

Each tenure gets one durable agent derived from the Duty ID, tenure, and project, then registered
against that project. Its runs are ordinary sessions the Happy app already lists and reads.

## Waking

Three things start a run: issuance, `activateDuty`, and a Duty's own interval. The interval is the
module's own alarm — measured from when the last run _settled_, so a slow run cannot build a backlog
of wakes, and re-armed from the stored `nextWakeAt` on every start. A Duty still working when its
interval comes due is left alone rather than given a second run.

`recover` runs after agents restore and re-offers the wake for any run the last process left
unsettled. Wakes are idempotent — Agent Base accepts one message ID once — so this is safe whether
the agent already has the message or a crash lost it. Without it, a run interrupted between issuance
and acceptance would stay `queued` forever and `activateDuty` would keep handing back that dead run.

## Enforcement

`beforeToolCall` refuses any tool outside `allowed_tools`, and refuses everything but Duty
inspection while a Duty is paused. It clamps the permission mode to the Duty's ceiling — but only
when that ceiling is actually the narrower of the two. Decisions fold last-wins and this module is
ordered after the permission broker, so naming the agent's own mode would silently discard an
elevation a person had just approved.

Message metadata is untrusted input, and the hook that correlates a wake with its run commits inside
the transaction that accepts the message. A claim naming an unknown or foreign run is therefore
ignored rather than rejected: throwing would roll the acceptance back and one bad claim would block
the agent's queue permanently.

## Protocol independence

Roster bindings, runs, and alarms are local to the daemon. Their wake is an ordinary user-role
message of the same shape scheduling and collaboration already send.

That is deliberate: it lets Duties run against an **unmodified** happy.engineering deployment.
Happy machine RPC is an optional control path over the existing encrypted relay, not a prerequisite
for issuance, inspection, replacement, recovery, or periodic wakes. An existing Happy client can
send a normal message to an ordinary Rig session, approve the standard tool call, and then see and
message the dedicated holder as another ordinary session.
