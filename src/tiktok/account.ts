// TikTok account check and switch for the agentic doomscroll. Worked out on
// the French iOS app on an iPhone XR (2026-11):
//
//   Profil tab → the header shows the name in big bold letters with a ▼ right
//   of it ("Changer de compte"), the @handle under it, then the stats row.
//   All of it is read off screenshots (OCR + pixels), like a creator's
//   profile (creator-profile.ts): the accessibility tree is slow and can hang
//   WDA. The ▼ opens the switcher sheet, whose rows are found with OCR too.
//   Tapping a row reloads the app on the Profile tab in ~4 s; Accueil goes
//   back to For You.
//
// The tab bar is tapped from the coordinate profile.

import sharp from 'sharp';

import type { AccountCheck, AppContext } from '../agent/session.js';
import { tapCoordinate } from './actions.js';
import { profileHeaderFromWords, readProfileHeaderWords } from './creator-profile.js';
import { findHandleMatch, pointFromWord, recognizeWords, type OcrWord } from './ocr.js';

export interface Point { x: number; y: number }

const bare = (handle: string) => handle.trim().replace(/^@/, '').toLowerCase();

/** Handles compare without the @ and case: "@MetaFruit67" = "metafruit67". */
export function sameHandle(a: string, b: string): boolean {
    return bare(a) !== '' && bare(a) === bare(b);
}

function editDistance(a: string, b: string): number {
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const current = [i];
        for (let j = 1; j <= b.length; j++) {
            current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        previous = current;
    }
    return previous[b.length]!;
}

/**
 * The handle OCR read on the Profile tab is `target`: the same, or one
 * character off on a handle of 6+ ("@metafruité67" for "@metafruit67").
 */
export function readsAsHandle(read: string, target: string): boolean {
    if (sameHandle(read, target)) return true;
    const a = bare(read), b = bare(target);
    return Math.min(a.length, b.length) >= 6 && editDistance(a, b) <= 1;
}

export interface OwnProfile {
    /** "@metafruit67", as OCR read it. */
    handle: string;
    /** The ▼ that opens the account switcher (points), when found. */
    switcher?: Point;
}

/** The name in the header: the tallest word on the lines just above the @handle. */
export function pickNameWord(words: readonly OcrWord[], handleWord: OcrWord): OcrWord | undefined {
    return words
        .filter((word) => word !== handleWord && word.y + word.height <= handleWord.y + handleWord.height * 0.3
            && word.y >= handleWord.y - handleWord.height * 5 && /[\p{L}\p{N}]/u.test(word.text))
        .sort((a, b) => b.height - a.height)[0];
}

const isDark = (r: number, g: number, b: number) => Math.max(r, g, b) < 110;

/**
 * The ▼ right of the name, in raw pixels: along the name's row, the last
 * cluster of dark columns, if it is narrow and much shorter than the letters
 * (a letter like "7" is as tall as the name). OCR sometimes folds the ▼ into
 * the word ("metafruit67-"), so the scan starts at the word, not after it.
 */
export function findSwitcherArrow(data: Buffer, width: number, channels: number, name: OcrWord, scale: number): Point | undefined {
    const top = Math.round(name.y), bottom = Math.round(name.y + name.height);
    const from = Math.round(name.x), to = Math.min(width, Math.round(name.x + name.width + 40 * scale));
    const clusters: { start: number; end: number; minY: number; maxY: number }[] = [];
    const gap = Math.round(3 * scale);
    for (let x = from; x < to; x++) {
        let minY = Infinity, maxY = -Infinity;
        for (let y = top; y < bottom; y++) {
            const offset = (y * width + x) * channels;
            if (isDark(data[offset]!, data[offset + 1]!, data[offset + 2]!)) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
        }
        if (minY === Infinity) continue;
        const last = clusters.at(-1);
        if (last && x - last.end <= gap) {
            last.end = x; last.minY = Math.min(last.minY, minY); last.maxY = Math.max(last.maxY, maxY);
        } else {
            clusters.push({ start: x, end: x, minY, maxY });
        }
    }
    const arrow = clusters.at(-1);
    if (!arrow || clusters.length < 2) return undefined;
    const arrowWidth = arrow.end - arrow.start + 1;
    const arrowHeight = arrow.maxY - arrow.minY + 1;
    if (arrowWidth > 16 * scale || arrowWidth < 4 * scale || arrowHeight > name.height * 0.45) return undefined;
    return { x: Math.round((arrow.start + arrow.end) / 2), y: Math.round((arrow.minY + arrow.maxY) / 2) };
}

/** Our own Profile tab read off a screenshot (light mode), or undefined when it isn't on screen. */
export async function readOwnProfile(screenshot: Buffer, scale: number): Promise<OwnProfile | undefined> {
    const { data, info } = await sharp(screenshot).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const words = await readProfileHeaderWords(data, info.width, info.height, info.channels);
    const header = profileHeaderFromWords(words);
    if (!header.profile || !header.handle) return undefined;
    const handleWord = words.find((word) => word.text.trim() === header.handle)!;
    const name = pickNameWord(words, handleWord);
    const arrow = name && findSwitcherArrow(data, info.width, info.channels, name, scale);
    return {
        handle: header.handle,
        ...(arrow ? { switcher: { x: Math.round(arrow.x / scale), y: Math.round(arrow.y / scale) } } : {}),
    };
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

async function readProfile(context: AppContext, timeoutMs: number): Promise<OwnProfile | undefined> {
    const until = Date.now() + timeoutMs;
    do {
        const profile = await readOwnProfile(await context.screenshot(), context.scale).catch(() => undefined);
        if (profile) return profile;
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
    if (!profile) throw new Error('Could not read the TikTok account on the Profile tab (no @handle and stats row on screen)');
    const from = profile.handle;
    let current = profile;

    if (!readsAsHandle(from, target)) {
        console.log(`[agent] TikTok is on ${from}; switching to ${target}`);
        const heightPx = context.window.height * context.scale;
        let words: OcrWord[] = [];
        let opened = false;
        // A fresh launch can show a tooltip over the header ("Quoi de neuf ?")
        // that swallows the first tap: retry, checking the sheet each time.
        for (let attempt = 1; attempt <= SWITCHER_ATTEMPTS && !opened; attempt++) {
            const button = current.switcher;
            if (!button) throw new Error('Could not find TikTok\'s "Changer de compte" button on the Profile tab');
            await tapCoordinate(context.driver, button.x, button.y, `Account switcher (attempt ${attempt})`, { radius: 3 });
            await sleep(1500);
            words = await recognizeWords(await context.screenshot());
            opened = switcherOpen(words, heightPx) || switcherRow(words, target, heightPx) !== undefined;
            if (!opened) current = (await readProfile(context, 3000)) ?? current;
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
        if (!after || !readsAsHandle(after.handle, target)) {
            throw new Error(`Switched TikTok account but the Profile tab shows ${after?.handle ?? 'nothing readable'}, not ${target}`);
        }
        console.log(`[agent] TikTok switched to ${after.handle}`);
    } else {
        console.log(`[agent] TikTok is on ${from} as expected`);
    }

    // A short look at the profile, like a person checking, then back to For You.
    await sleep(800 + Math.random() * 1500);
    await tapCoordinate(context.driver, tiktok.homeTab.x, tiktok.homeTab.y, 'Home tab', { radius: 6 });
    await sleep(2500 + Math.random() * 1000);
    return { from, switched: !readsAsHandle(from, target), durationMs: Date.now() - started };
}
