# Native source

`cli.rs` owns the injection-resistant invocation, `policy.rs` owns validation,
`exec.rs` resolves PATH only after the security boundary is active, `proxy/`
translates loopback proxy protocols onto one pre-connected descriptor, and
`platform/` applies Linux or macOS enforcement.
