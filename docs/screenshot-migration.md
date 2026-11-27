# Replacing the accessibility tree with screenshots

WDA's page source (`mobile: source`, `/source`, `$('~id')` lookups) is slow
on busy screens (4-15 s) and can hang WDA and the app. Everything moves to
screenshots (OCR, templates, pixels). Done so far: the creator profile
(`src/tiktok/creator-profile.ts`, commit dc5dbc5).

Each step is its own commit, with `npm test` on screenshot fixtures and a tiny
on-phone check (5-10 videos, one switch, or one comment).

## 1. TikTok account check — `src/tiktok/account.ts`
- `@handle`: OCR of the Profile header (`findHandleMatch` + the header test from `creator-profile.ts`).
- ▼ switcher: pixel search just right of the name row (the row's height comes from OCR).
- Tabs: coordinates only; drop `tabButton`.
- Fixtures: 2-3 screenshots of our own Profile tab; rewrite `test/tiktok-account.test.ts`.

## 2. `phone_look` — `src/agent/explore.ts`, `src/agent/mcp.ts`
- Replace the element list with OCR words: text, centre and size in points.
- Update the tool description.

## 3. Instagram Reels — `src/instagram/reels-screen.ts`, `agent-adapter.ts`, `reels-doomscroll.ts`
- Move the template matcher in `src/facebook/reels-controls.ts` into a shared module; add Instagram heart, comment and share templates (XR, scale 2).
- liked: red pixels in the heart. ad: OCR "Sponsorisé(e)"/"Sponsored" in the caption area.
- onReels: Reels tab icon selected (fixed point in the tab bar). progress: bottom bar pixel scan, like `src/tiktok/video-progress.ts`.
- reelId: account name read by OCR from the caption, frame hash as fallback.
- Replace the `.json` tree fixtures with `.jpg` for the same cases (reel, liked, ad-reel, ad-photo, threads-card, no-progress, short caption).

## 4. Comment flow — `src/agent/comment-flow.ts`, `src/instagram/comment.ts`, `src/facebook/comment.ts`
- Instagram comment button: from the rail detection (step 3). Facebook already uses screenshots.
- Text box: OCR of the placeholder ("Ajouter un commentaire…") on the grey pill.
- Send: OCR "Publier", or the blue send arrow on the text box's row.
- Comment taken: the placeholder comes back. `onFeed`: the rail is detected again.
- `pickComposer`/`pickSend` take OCR words; update `test/comment.test.ts`.

## 5. Keyboard — `src/devices/wda-keyboard.ts`, `src/devices/typing.ts`
Keyboards differ by field: an email or username field can add "@" or "." to
the default layout, return can read "Envoyer"/"Rechercher", dark mode changes
the colours. So nothing is assumed: the screen is compared with a reference.

- **References**, per phone model + keyboard language + appearance, one per
  layer (lower, upper, 123, #+=): a cropped screenshot of the key area plus a
  JSON key map (label + rect in points). Built once by a calibration script
  (screenshot → OCR proposes labels → reviewed by hand). This is the OCR
  "cache": typing never runs OCR on keys.
- **Matching**: crop the key area of a fresh screenshot (the QuickType
  suggestion bar above it is excluded, it changes with the text), compare it
  key cell by key cell with each reference. Every cell must match:
  then that layer's key map is used.
- **Layer checks** while typing (before each word, after shift/123): the same
  match, replacing `readKeyboard`/`hasKey`.
- **Keyboard visible**: any reference matches (or the keyboard's grey band is
  there, for the "is it open yet" poll).
- **Mismatch → flag and escape**: when no reference matches (extra key,
  different layout, unknown layer), throw `KeyboardLayoutMismatch`, save the
  screenshot to `logs/` and log a warning. The comment flow catches it, closes
  the keyboard and the sheet (`closeCommentSheet`), counts the comment as
  skipped and goes back to scrolling. Never type on a layout that wasn't matched.
- `open()`: callers always pass the field's point (no text-field lookup).

## 6. Cleanup
- Delete `src/agent/page-source.ts`, `parseSource`, `SourceNode`.
- A test that fails if `mobile: source`, `/source`, `driver.$(` or `$$(`
  shows up in `src/` (except `src/tiktok/post.ts` until it's done, below).

## Later: TikTok post — `src/tiktok/post.ts`
Not in this round. `firstDisplayed`/`clickOne` still find "Use this sound"
by accessibility id / predicate. To do: OCR the label on the red button and
tap the word's centre, like the account switcher rows.
