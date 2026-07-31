# Scheduling

This module defines Rig's provider-neutral scheduling tools and their durable data shapes.

```text
wait / wait_until ──> session-owned durable wait ──> resumed tool result
schedule_message ───> durable scheduled message ──> Agent ID delivery
```

The tools are assembled once for every model. Session and persistence code own clocks, restart
recovery, message interruption, delivery, and synchronization.
