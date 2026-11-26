---
name: tiktok-doomscroll
description: Agentic TikTok doomscroll that locks an account's niche — a vision model judges each video on the phone. Use when the user asks to doomscroll TikTok with an account/niche, e.g. "doomscroll @fitjulie for 10 min as casual".
---

# Agentic TikTok doomscroll

1. Get from the request: the account handle, the minutes (1–60), and the personality (skimmer, casual or engaged; default casual). Ask only if the account is missing.
2. Run the session with Bash in the background (`run_in_background: true`):
   `npm run agent:scroll -- --account @handle --minutes N --personality P`
   Each video is judged by a vision model on OpenRouter (`deepseek/deepseek-v4.1-flash-1017` by default; `AGENT_MODEL` in `.env` overrides it). Ads and TikTok Shop posts are skipped in code without a model call. It prints one line per video and a `done:` summary at the end.
3. Relay the summary in plain words: videos seen, share on-niche, like/save rates, and the median skip screen time (`medianSkipScreenMs`; aim ≲ 3000 ms). Mention the log folder (`logDirectory`: one screenshot per video plus `decisions.jsonl`).

Prerequisites, if the start fails: `OPENROUTER_API_KEY` in `.env`, Appium and the WDA service running, the phone connected and not used by a scheduled task, TikTok already on that account (the session does not switch accounts), the account listed under the device's Accounts, and a niche saved for it (device page → Niches).

The older Claude Code version (the `tiktok-scroller` subagent on Haiku through the `tiktok-agent` MCP tools) still works but is about 4× slower per decision.
