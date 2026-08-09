# Folder-share persistence

This directory owns Rig's durable application state for Murmur folder groups.

```text
FolderRepository tree
        |
        v
folder_share_intents
        |
        v
folder_shares ----> folder_share_nodes
        |
        +---------> folder_share_outbox
        |
        +---------> folder_share_updates
```

Murmur keeps MLS keys, epochs, encrypted queues, and replay state in its own store. These tables
keep the materialized virtual tree, per-folder operation registers, deterministic application
clock, bounded idempotency receipts, recoverable creation intent, and compact pending application
packets. Database state is always written before Murmur is asked to send.
