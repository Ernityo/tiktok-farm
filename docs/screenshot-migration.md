# Replacing the accessibility tree with screenshots

WDA's page source (`mobile: source`, `/source`, `$('~id')` lookups) is slow
on busy screens (4-15 s) and can hang WDA and the app. Screens are now read
off screenshots (OCR, templates, pixels) everywhere except the TikTok post
flow (below). `test/no-accessibility-tree.test.ts` fails if a tree read comes
back in `src/`.

Fixtures are real screenshots from an iPhone XR (2x), French UI, 2026-11-28,
except where noted.

## Done

1. **Creator profile** — `src/tiktok/creator-profile.ts` (before this round).
2. **TikTok account check** — `src/tiktok/account.ts`. `@handle` by OCR of
   the Profile header (one OCR slip allowed on handles of 6+), the ▼ switcher
   by a pixel scan right of the name, tabs from the coordinate profile.
3. **`phone_look`** — `src/agent/screen-text.ts`. OCR phrases (both
   polarities) with centre and size in points; the option is now `words`.
4. **Instagram Reels** — `src/instagram/reels-screen.ts`. Rail by template
   matching (`src/agent/icon-match.ts`, shared with Facebook): comment bubble,
   then the heart 38-82 pt above it, or a filled red heart once liked.
   "Sponsorisée" and the account name (reel id) by OCR of the caption band,
   progress from the bar above the tab bar, Reels tab from the tab icons.
5. **Comment flow** — `src/agent/comment-flow.ts`. Empty text box by its
   placeholder (OCR), send button by its blue, comment confirmed when the
   placeholder comes back.
6. **Keyboard** — `src/devices/screen-keyboard.ts`. Compared key by key with
   reference screenshots (`src/devices/keyboards/<set>/`, one per layer, key
   maps reviewed by hand); only an exact match is typed on. No match →
   `KeyboardLayoutMismatch`, screenshot saved to `logs/keyboard-mismatch/`,
   the comment flow closes the sheet and the feed goes on. The accent key and
   shift (letter layers) are left out of the comparison.
   New keyboard: `npm run keyboard:calibrate -- --set <name> --layer <layer>
   --screenshot <file>` proposes labels; check them and run again with
   `--row` ×4 to write the reference.

## Still to check on the phone

- **Instagram liked heart**: the fixture is a real Reel with its heart filled
  red by hand (no liked Reel on the test account). The agent's like
  confirmation will show whether a real liked heart reads as liked.
- **Comment end to end** on Instagram and Facebook: the sheet, keyboard and
  send-button screenshots are real, but no comment was sent with the new code.
- **Keyboards**: only the comment boxes' French AZERTY keyboards on the XR
  have references (Instagram dark with @/#, Facebook light). Dark mode on
  Facebook, another phone or another field will be refused (and saved) until
  calibrated.
- **TikTok account switch**: reading the handle and the ▼ is tested on our
  own Profile tab; a switch to the other account wasn't run.
- Instagram cards (Threads posts, suggestions, surveys): no screenshot of one
  yet; with no rail found they read as "other" and are skipped.

## Later: TikTok post — `src/tiktok/post.ts`

Not in this round. `firstDisplayed`/`clickOne` still find "Use this sound"
by accessibility id / predicate. To do: OCR the label on the red button and
tap the word's centre, like the account switcher rows. Then remove it from
the guard test's allowed list.
