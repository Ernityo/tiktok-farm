---
name: tiktok-doomscroll
description: Agentic TikTok doomscroll that locks an account's niche — Claude judges each video on the phone. Use when the user asks to doomscroll TikTok with an account/niche, e.g. "doomscroll @fitjulie for 10 min as casual".
---

# Agentic TikTok doomscroll

1. Get from the request: the account handle, the minutes (1–60), and the personality (skimmer, casual or engaged; default casual). Ask only if the account is missing.
2. Delegate the whole session to the `tiktok-scroller` subagent (it runs on Haiku for fast decisions and keeps the screenshots out of this conversation). Prompt it with just: `account: @handle · minutes: N · personality: P`.
3. Relay its summary in plain words: videos seen, share on-niche, like/save rates, and the median skip screen time (`medianSkipScreenMs`; aim ≲ 3000 ms). Mention the log folder.

Prerequisites, if the start fails: Appium and the WDA service running, the phone connected and not used by a scheduled task, the account listed under the device's Accounts, and a niche saved for it (device page → Niches).
