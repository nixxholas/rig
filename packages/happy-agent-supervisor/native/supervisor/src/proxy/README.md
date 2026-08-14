# Outgoing proxy

`mux.rs` carries every stream over the one descriptor Rig connected before the
sandbox existed, with per-stream credit so a stalled workload connection cannot
stall the rest. `http.rs` and `socks.rs` translate `CONNECT`, absolute-URI, and
SOCKS5 into `open_stream(host, port)`; `bridge.rs` joins an accepted loopback
socket to its stream.

No TLS is unwrapped here and no certificate is minted here. The host proxy owns
policy, name resolution, the certificate authority, and any TLS termination.
