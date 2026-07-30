# Happy integration

This module owns Rig's Happy protocol integration. It imports local Happy
credentials, connects a machine and session to Happy, translates session
events, and synchronizes the encrypted outbox. SQLite reads and mutations live
in `persistence/happy`; this module coordinates that behavior with Happy's
remote protocol.

```
local credentials
       |
       v
HappySyncService ---> HappySyncRepository ---> persistence/happy
       |                      |
       v                      v
HappySessionClient        SQLite database
       |
       v
Happy remote service
```

Top-level files are the important protocol clients, synchronization service,
credential helpers, message mapper, and public types. They are kept here
because callers outside this module use several of them directly.

## Failure behavior

Database failures are fatal. The service may retry remote transport failures
and an outbox-capacity signal, but it must rethrow any persistence failure so
the daemon terminates instead of silently losing synchronization state.

## Tests

`tests/` covers the public Happy clients, synchronization, credential handling,
encryption, RPC dispatch, and message translation.
