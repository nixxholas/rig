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

The module intentionally adds no HTTP or Happy RPC route. Callers embedded in the Rig runtime use
`runtime.modules.duty`; exposing these operations remotely is a separate API-contract change.
