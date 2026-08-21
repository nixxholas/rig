# Duty module

`DutyModule` binds a durable Rig agent to one machine-issued charter. Issuance is a public module
operation, not a model tool, so an agent cannot promote itself or broaden its own authority.

```text
machine issuer
    | issueDuty / activateDuty
    v
durable binding + run -- AgentSystemRef.send --> bound Rig agent
    |                                             |
    |                                             +-- instructions
    |                                             +-- allowed-tool enforcement
    +<------------ settlement hook ---------------+
```

One module instance serves every agent. Bindings and run records live in module-owned database
tables and survive process restarts. Wake messages are agent-originated and carry no human
authority. `get_duty` is the only Duty-owned model tool; lifecycle control remains with the issuer.

When Rig is connected to Happy, it additionally registers `duty-issue`, `duty-activate`,
`duty-status`, `duty-pause`, `duty-resume`, and `duty-stop` as machine-local RPC methods. They use
Happy's existing encrypted namespaced machine relay, so an unchanged Happy server and existing
Happy clients continue to use `spawn-happy-session` exactly as before. The methods are available
only on a Rig machine; they do not add an HTTP route or change Happy's deployed app protocol.
