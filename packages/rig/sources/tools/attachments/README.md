# Attachments

The `attach` tool prepares a model's pending final-message attachments. The
session owns `AttachmentContext`: it calls `takePending()` after a normal
terminal response and `discard()` after an abort or error. Completed
attachments survive steering because steering continues the same overall run.

Images are decoded with Sharp and receive dimensions plus a ThumbHash. Video
and audio metadata comes from `ffprobe`; video frames are extracted in a
temporary workspace path, then persisted through the host-owned generated-media
store. URL metadata comes from bounded HTML fetches and Open Graph tags.
