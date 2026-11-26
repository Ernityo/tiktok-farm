// TikTok account check and switch for the agentic doomscroll. Worked out on
// the French iOS app on an iPhone XR (2026-11):
//
//   Profil tab → the handle is the `user_account_user_name` element
//   ("@metafruit67"); the ▼ next to the name ("Changer de compte",
//   name IconArrowTriangleDownLargeFill) opens the switcher sheet. The sheet
//   is NOT in the accessibility tree, so its rows are found with OCR. Tapping
//   a row reloads the app on the Profile tab in ~4 s; Accueil goes back to
//   For You.
//
// The feed's page source can hang (constantly updating video), so the tab
// bar is tapped from the coordinate profile while on the feed; the Profile
// page's tree reads fine.

import type { AccountCheck, AppContext } from '../agent/session.js';
import type { SourceNode } from '../instagram/reels-screen.js';
import { readSource } from '../agent/page-source.js';
import { tapCoordinate } from './actions.js';
import { findHandleMatch, pointFromWord, recognizeWords, type OcrWord } from './ocr.js';

export interface Point { x: number; y: number }

const clean = (text: string | null | undefined) => (text ?? '').replace(/[  ‎⁨⁩]/g, ' ').trim();
const isVisible = (node: SourceNode) => node.isVisible === undefined || node.isVisible === true || node.isVisible === '1';

/** Handles compare without the @ and case: "@MetaFruit67" = "metafruit67". */
export function sameHandle(a: string, b: string): boolean {
    const bare = (handle: string) => handle.trim().replace(/^@/, '').toLowerCase();
    return bare(a) !== '' && bare(a) === bare(b);
}

function find(root: SourceNode, match: (node: SourceNode) => boolean): SourceNode | undefined {
    const stack = [root];
    while (stack.length) {
        const node = stack.pop()!;
        if (match(node) && isVisible(node)) return node;
        for (const child of [...(node.children ?? [])].reverse()) stack.push(child);
    }
    return undefined;
}

function centre(node: SourceNode | undefined): Point | undefined {
    const rect = node?.rect;
    if (!rect || rect.width <= 0 || rect.height <= 0) return undefined;
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
}

/** The handle shown on the Profile tab ("@metafruit67"), or undefined when not on it. */
export function profileHandle(root: SourceNode): string | undefined {
    const node = find(root, (n) => n.name === 'user_account_user_name');
    const handle = clean(node?.label ?? node?.value);
    return handle ? (handle.startsWith('@') ? handle : `@${handle}`) : undefined;
}

/** The ▼ that opens the account switcher on the Profile tab. */
export function switcherButton(root: SourceNode): Point | undefined {
    return centre(find(root, (n) => (n.type === 'Button' || n.type === 'XCUIElementTypeButton')
        && (/^(Changer de compte|Switch account)$/i.test(clean(n.label)) || n.name === 'IconArrowTriangleDownLargeFill')));
}

/** A bottom tab by its stable name (a11y_vo_home, a11y_vo_profile). */
export function tabButton(root: SourceNode, name: 'a11y_vo_home' | 'a11y_vo_profile'): Point | undefined {
    return centre(find(root, (n) => n.name === name));
}

/** The switcher sheet is open: its title shows near the bottom half (OCR). */
export function switcherOpen(words: readonly OcrWord[], screenHeightPx: number): boolean {
    const text = (word: OcrWord) => word.text.trim().toLowerCase();
    // "Changer de compte" / "Switch account": the sheet title sits low on the
    // screen, unlike the profile's own name row at the top.
    return words.some((word, i) => word.y > screenHeightPx * 0.4
        && ((text(word) === 'changer' && text(words[i + 1] ?? word) === 'de') || (text(word) === 'switch' && /^account/.test(text(words[i + 1] ?? word)))));
}

/** The row for `handle` in the open switcher sheet (OCR words, device pixels), lower half only. */
export function switcherRow(words: readonly OcrWord[], handle: string, screenHeightPx: number): OcrWord | undefined {
    return findHandleMatch(words.filter((word) => word.y > screenHeightPx * 0.4), handle);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function readProfile(context: AppContext, timeoutMs: number): Promise<{ tree: SourceNode; handle: string } | undefined> {
    const until = Date.now() + timeoutMs;
    do {
        const tree = await readSource(context).catch(() => undefined);
        const handle = tree && profileHandle(tree);
        if (tree && handle) return { tree, handle };
        await sleep(800);
    } while (Date.now() < until);
    return undefined;
}


const SWITCHER_ATTEMPTS = 3;

/**
 * From the For You feed: opens the Profile tab, reads the account, switches
 * to `target` if it isn't the one, and goes back to For You. Throws when the
 * account can't be read or the switch can't be confirmed (the caller should
 * not keep scrolling on the wrong account).
 */
export async function ensureTikTokAccount(context: AppContext, target: string): Promise<AccountCheck> {
    const started = Date.now();
    const tiktok = context.coordinates.tiktok;
    await tapCoordinate(context.driver, tiktok.profileTab.x, tiktok.profileTab.y, 'Profile tab', { radius: 6 });
    await sleep(1500 + Math.random() * 1000);

    const profile = await readProfile(context, 8000);
    if (!profile) throw new Error('Could not read the TikTok account on the Profile tab (no user_account_user_name element)');
    const from = profile.handle;
    let tree = profile.tree;

    if (!sameHandle(from, target)) {
        console.log(`[agent] TikTok is on ${from}; switching to ${target}`);
        const heightPx = context.window.height * context.scale;
        let words: OcrWord[] = [];
        let opened = false;
        // A fresh launch can show a tooltip over the header ("Quoi de neuf ?")
        // that swallows the first tap: retry, checking the sheet each time.
        for (let attempt = 1; attempt <= SWITCHER_ATTEMPTS && !opened; attempt++) {
            const button = switcherButton(tree);
            if (!button) throw new Error('Could not find TikTok\'s "Changer de compte" button on the Profile tab');
            await tapCoordinate(context.driver, button.x, button.y, `Account switcher (attempt ${attempt})`, { radius: 3 });
            await sleep(1500);
            words = await recognizeWords(await context.screenshot());
            opened = switcherOpen(words, heightPx) || switcherRow(words, target, heightPx) !== undefined;
            if (!opened) tree = (await readProfile(context, 3000))?.tree ?? tree;
        }
        if (!opened) throw new Error(`Could not open the TikTok account switcher after ${SWITCHER_ATTEMPTS} attempts`);

        const row = switcherRow(words, target, heightPx);
        if (!row) {
            const seen = words.filter((word) => word.y > heightPx * 0.4).map((word) => word.text).join(' ') || '(nothing read)';
            throw new Error(`${target} is not in TikTok's account switcher (is it logged in on this phone?). OCR saw: ${seen}`);
        }
        const point = pointFromWord(row, context.scale);
        await tapCoordinate(context.driver, point.x, point.y, `Account row ${target}`, { radius: 4 });
        // The app reloads on the Profile tab of the new account.
        await sleep(3500);
        const after = await readProfile(context, 10000);
        if (!after || !sameHandle(after.handle, target)) {
            throw new Error(`Switched TikTok account but the Profile tab shows ${after?.handle ?? 'nothing readable'}, not ${target}`);
        }
        tree = after.tree;
        console.log(`[agent] TikTok switched to ${after.handle}`);
    } else {
        console.log(`[agent] TikTok is on ${from} as expected`);
    }

    // A short look at the profile, like a person checking, then back to For You.
    await sleep(800 + Math.random() * 1500);
    const home = tabButton(tree, 'a11y_vo_home') ?? tiktok.homeTab;
    await tapCoordinate(context.driver, home.x, home.y, 'Home tab', { radius: 6 });
    await sleep(2500 + Math.random() * 1000);
    return { from, switched: !sameHandle(from, target), durationMs: Date.now() - started };
}
