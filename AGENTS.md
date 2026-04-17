# Project Agent Instructions

When a task needs browser automation, YouTube, YouTube Shorts, Instagram Reels, TikTok, artifacts, screenshots, traces, or saved run summaries, use the `odm_explorations` MCP server tools when they are available.

Prefer the site-specific MCP tools for supported workflows:

- Use `youtube_collect_shorts` for YouTube Shorts metadata.
- Use `youtube_collect_short_transcripts` for YouTube Shorts transcripts or captions.
- Use `instagram_collect_reels` for Instagram Reels.
- Use `tiktok_collect_videos` for TikTok videos.
- Use `artifact_list` and `artifact_read` to inspect saved artifacts.

Use generic browser tools only when a site-specific tool does not cover the task.
