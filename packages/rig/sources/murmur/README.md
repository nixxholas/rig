# Murmur

This module owns Rig's local Murmur identity, service lifecycle, incoming friend
requests, and accepted contacts.

```text
HTTP API
   |
MurmurService ---- durable MurmurStore
   |                    |
MurmurClient       account / pending requests / cursors / contacts
   |
RelayTransport[] ---- Murmur relays
```

There is at most one durable account in a store. Signup creates independent
Ed25519 and X25519 keys and stores them with a normalized profile. The public
account response contains only the Murmur ID, public token, and profile.

`start()` reconstructs the runtime identity, subscribes its first-contact
inbox, and owns one abortable synchronization loop. `stop()` joins that loop and
overwrites the in-memory identity secrets. Deleting an account additionally
closes the SQLite store, removes its database/WAL/SHM files, and opens a fresh
empty store through the configured factory.

Incoming encrypted profiles remain pending requests, with a fixed 1,000-request
storage bound. Answering requires the service to be running so every configured
relay can first remove the request from its permanent inbox list. Accepting then
saves the authenticated profile through Murmur's `ContactBook` in the same
transaction that records the answer and removes the pending record; rejecting
records the answer and removes the pending record. These handled markers are
bounded because the permanent relay entry has already been deleted. Malformed
or over-capacity relay payloads are bounded in quarantine and their cursor still
advances.

Hosted relay calls have a 30-second deadline. Transient synchronization and
reset-loading failures retry without leaving a false running state, while
SQLite failures retain their original cause and reach Rig's fatal database
boundary.

Outbound friend requests and answers use durable prepared signed events rather
than generating a new event on each retry. The record tracks exactly which
relays accepted the event, skips them on later attempts, and is removed only
after every relay and the local semantic transaction have completed. Pending
friend-request sends retain at most 256 encrypted profile events; answers share
the 1,000-request inbound bound.
