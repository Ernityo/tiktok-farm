// Following a TikTok creator from their profile, for the warm-up. Worked out
// on the French iOS app on an iPhone XR (2026-11):
//
//   Feed: tapping the creator's name (the bold first line of the caption,
//   bottom left) opens their profile. The avatar is avoided: a ring around it
//   (a story) can open the story instead.
//   Profile: read off screenshots only. Its accessibility tree often took
//   over 6-15 s and could hang WDA (and the app with it), so it isn't used.
//   The stats row ("Suivis · Followers · J'aime") says it's a profile; the
//   big red "Suivre" pill spans most of the width; after following it becomes
//   "Message" plus "Suivis ▾". Following can open a "Comptes suggérés" strip
//   with its own (narrow) "Suivre" buttons: never tap those. The video grid
//   starts below, three tiles a row.
//   A tile opens a player (its page source hangs, like the feed) with "<" at
//   the top left; a quick swipe up shows the creator's next video.
//   Back: player "<" → profile; profile `nav_bar_start_back` → feed. The app
//   lags here: a screenshot can still show the profile after going back, and
//   the feed's LIVE button sits exactly where the profile's back arrow was.
//   So every back tap is guarded by a fresh screenshot of the profile.

import sharp from 'sharp';

import { AppStuckError } from '../agent/comment.js';
import type { AppContext } from '../agent/session.js';
import { tapCoordinate } from './actions.js';
import { recognizeWords, type OcrWord } from './ocr.js';

export interface Point { x: number; y: number }

/** Where the caption's name line is looked for, as shares of the screen (left of the rail, above the tab bar). */
const NAME_REGION = { left: 0, top: 0.68, width: 0.78, height: 0.26 } as const;
/** The name line starts at the left margin; burnt-in subtitles are centred. */
const LEFT_MARGIN_SHARE = 0.08;
/** Caption lines that are never the name. */
const NOT_A_NAME = /^(#|@?contient|m[ée]dias|g[ée]n[ée]r[ée]|sponsoris|publicit|commission|voir|see\b)/i;

/**
 * The creator's name among OCR words of the caption region (pixel
 * coordinates of the region image): the topmost line that starts at the left
 * margin and isn't a hashtag or label line. Returns its first word.
 */
export function pickCreatorName(words: readonly OcrWord[], regionWidthPx: number): OcrWord | undefined {
    // Stray glyphs from bright video content ("!", "I") are dropped: a name has at least 3 letters or digits.
    const sorted = [...words].filter((word) => (word.text.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 3)
        .sort((a, b) => a.y - b.y || a.x - b.x);
    const lines: OcrWord[][] = [];
    for (const word of sorted) {
        const line = lines.find((candidate) => Math.abs(candidate[0]!.y - word.y) < Math.max(candidate[0]!.height, word.height) * 0.6);
        if (line) line.push(word);
        else lines.push([word]);
    }
    for (const line of lines) {
        line.sort((a, b) => a.x - b.x);
        const first = line[0]!;
        if (first.x > regionWidthPx * LEFT_MARGIN_SHARE) continue;
        if (NOT_A_NAME.test(first.text.trim())) continue;
        return first;
    }
    return undefined;
}

export type BottomBar = 'feed' | 'player' | 'other';

/** What the bottom strip's OCR words say: the feed's tab bar, the profile player's comment bar, or neither (profile, LIVE...). */
export function bottomBarFromWords(words: readonly OcrWord[]): BottomBar {
    const texts = words.map((word) => word.text.trim().toLowerCase().replace(/[^a-zà-ÿ]/g, ''));
    if (texts.some((text) => /^(accueil|amis|messages|profil|home|friends|inbox|profile)$/.test(text))) return 'feed';
    if (texts.some((text) => /^(ajouter|commentaire|comment)$/.test(text))) return 'player';
    return 'other';
}

/** Reads the bottom 10% of a screenshot (light text over the dark bar). */
export async function readBottomBar(screenshot: Buffer): Promise<BottomBar> {
    const { width = 0, height = 0 } = await sharp(screenshot).metadata();
    const strip = await sharp(screenshot).extract({ left: 0, top: Math.round(height * 0.9), width, height: height - Math.round(height * 0.9) }).toBuffer();
    return bottomBarFromWords(await recognizeWords(await whiteText(strip, 150)));
}

/** White caption text only (as black on white), like the caption OCR. */
async function whiteText(image: Buffer, threshold = 215): Promise<Buffer> {
    const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const mask = Buffer.alloc(info.width * info.height);
    for (let index = 0; index < mask.length; index++) {
        const offset = index * info.channels;
        mask[index] = Math.min(data[offset]!, data[offset + 1]!, data[offset + 2]!) > threshold ? 0 : 255;
    }
    return sharp(mask, { raw: { width: info.width, height: info.height, channels: 1 } }).withMetadata({ density: 300 }).png().toBuffer();
}

/** Where to tap the creator's name on a feed screenshot (points), or undefined when it can't be read. */
export async function findCreatorName(screenshot: Buffer, scale: number): Promise<Point | undefined> {
    const { width = 0, height = 0 } = await sharp(screenshot).metadata();
    const left = Math.round(width * NAME_REGION.left);
    const top = Math.round(height * NAME_REGION.top);
    const regionWidth = Math.round(width * NAME_REGION.width);
    const region = await sharp(screenshot).extract({ left, top, width: regionWidth, height: Math.round(height * NAME_REGION.height) }).toBuffer();
    const word = pickCreatorName(await recognizeWords(await whiteText(region)), regionWidth);
    if (!word) return undefined;
    return {
        // Inside the first word, short of its end: a name tap, never the "· Il y a 22 h" next to it.
        x: Math.round((left + word.x + Math.min(word.width / 2, 40 * scale)) / scale),
        y: Math.round((top + word.y + word.height / 2) / scale),
    };
}

export interface ProfileScreen {
    /** The @handle under the name, when OCR read it (for messages only). */
    handle?: string;
    /** The red Follow ("Suivre", or "Suivre en retour" next to Message) button under the stats row; never a suggested account's. */
    follow?: Point;
    /** "Message" shows where Suivre was: this account already follows the creator. */
    following: boolean;
    /** Centres of the first row of video tiles, when that row is fully on screen. */
    videos: Point[];
}

/** The profile's "<", top left (points). The feed's LIVE button sits in the same spot: only tap it on a profile. */
export const PROFILE_BACK: Point = { x: 29, y: 70 };

/** The header OCR'd for the stats row, handle and "Message": shares of the screen (the avatar on the right is left out). */
const HEADER_REGION = { top: 0.1, height: 0.24, width: 0.72 } as const;
/**
 * Where the Follow button is looked for: the row right under the stats (~26%
 * down). The suggested accounts' red buttons sit about halfway down, below it.
 */
const FOLLOW_BAND = { top: 0.18, bottom: 0.36 } as const;
/** "Suivre" spans ~69% of the width; "Suivre en retour" (beside Message) ~39%. */
const FOLLOW_MIN_WIDTH_SHARE = 0.3;
/** Widest white gap inside the button (between letters); the suggested cards sit ~7% apart. */
const MAX_LETTER_GAP_SHARE = 0.03;
/** A video tile's height over its width (measured: 218 px over 166 px). */
const TILE_ASPECT = 1.31;

/** Lower case letters only, with OCR's i/l/1 mix-ups folded together ("Foliowers" = "Followers"). */
const canonical = (text: string) => text.toLowerCase().replace(/[^a-zà-ÿ1|!]/g, '').replace(/[i1|!]/g, 'l');
const STAT_LABELS = [['followers', 'abonnés', 'abonnes'], ['suivis', 'suivi', 'following'], ['jaime', 'likes']].map((names) => names.map(canonical));

/**
 * What the header's OCR words say. A profile shows its @handle and the stats
 * row ("Suivis · Followers · J'aime"): the handle plus two of the three
 * labels. Low-confidence words are fine here: they're matched against this list.
 */
export function profileHeaderFromWords(words: readonly OcrWord[]): { profile: boolean; handle?: string; following: boolean } {
    const texts = words.map((word) => canonical(word.text));
    const labels = STAT_LABELS.filter((names) => texts.some((text) => names.includes(text))).length;
    const handleWord = words.find((word) => /^@[\w.]{2,}/.test(word.text.trim()));
    return {
        profile: Boolean(handleWord) && labels >= 2,
        ...(handleWord ? { handle: handleWord.text.trim() } : {}),
        following: texts.some((text) => text === 'message'),
    };
}

/** Dark text only (as black on white): the profile's labels on its white background. */
async function darkText(image: Buffer, threshold = 185): Promise<Buffer> {
    const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const mask = Buffer.alloc(info.width * info.height);
    for (let index = 0; index < mask.length; index++) {
        const offset = index * info.channels;
        mask[index] = Math.max(data[offset]!, data[offset + 1]!, data[offset + 2]!) < threshold ? 0 : 255;
    }
    // Small screenshots (MCP looks) read better doubled.
    const scaleUp = info.width < 600 ? 2 : 1;
    return sharp(mask, { raw: { width: info.width, height: info.height, channels: 1 } })
        .resize(info.width * scaleUp, info.height * scaleUp).withMetadata({ density: 300 }).png().toBuffer();
}

const isRed = (r: number, g: number, b: number) => r > 200 && g < 100 && b < 140 && r - g > 120;
const isBusy = (r: number, g: number, b: number) => {
    const max = Math.max(r, g, b);
    return 0.299 * r + 0.587 * g + 0.114 * b < 200 || max - Math.min(r, g, b) > 60;
};

/**
 * The big red Follow button in raw pixels: the topmost rows in the band whose
 * longest red run spans most of the width. Pixel coordinates, or undefined.
 */
export function findFollowButton(data: Buffer, width: number, height: number, channels: number): Point | undefined {
    const rows: { y: number; x: number; width: number }[] = [];
    for (let y = Math.round(height * FOLLOW_BAND.top); y < Math.round(height * FOLLOW_BAND.bottom); y++) {
        // A run bridges short gaps (the white "Suivre" letters), not the gaps between suggested accounts' cards.
        const maxGap = Math.round(width * MAX_LETTER_GAP_SHARE);
        let best = 0, bestEnd = 0, runStart = -1, lastRed = -1;
        for (let x = 0; x < width; x++) {
            const offset = (y * width + x) * channels;
            if (!isRed(data[offset]!, data[offset + 1]!, data[offset + 2]!)) continue;
            if (runStart < 0 || x - lastRed > maxGap) runStart = x;
            lastRed = x;
            if (x - runStart + 1 > best) { best = x - runStart + 1; bestEnd = x; }
        }
        if (best < width * FOLLOW_MIN_WIDTH_SHARE) continue;
        // Rows through the letters can fall short: a gap of a few rows still belongs to the same button.
        if (rows.length && y - rows.at(-1)!.y > height * 0.015) break;
        rows.push({ y, x: bestEnd - best / 2, width: best });
    }
    if (rows.length < 4) return undefined;
    // The widest row's centre: rows through the letters can count only half the button.
    const widest = rows.reduce((a, b) => (b.width > a.width ? b : a));
    return { x: Math.round(widest.x), y: Math.round((rows[0]!.y + rows.at(-1)!.y) / 2) };
}

/**
 * The top of the video grid in raw pixels: the first point below `fromY`
 * where a tile's worth of rows are almost all image (the bio and the
 * suggested accounts are mostly white or light grey).
 */
export function findGridTop(data: Buffer, width: number, height: number, channels: number, fromY: number, minRows: number): number | undefined {
    const busy: number[] = [];
    for (let y = 0; y < height; y++) {
        if (y < fromY) { busy.push(0); continue; }
        let count = 0;
        for (let x = 0; x < width; x += 2) {
            const offset = (y * width + x) * channels;
            if (isBusy(data[offset]!, data[offset + 1]!, data[offset + 2]!)) count++;
        }
        busy.push(count / Math.ceil(width / 2));
    }
    for (let y = fromY; y + minRows < height; y++) {
        let full = 0;
        for (let row = y; row < y + minRows; row++) if (busy[row]! > 0.8) full++;
        if (full >= minRows * 0.9) return y;
    }
    return undefined;
}

/**
 * OCR words of a profile's header (name, @handle, stats row, "Message"), in
 * pixels of the whole screenshot. Any confidence: match them against known text.
 * Works for a creator's profile and for our own Profile tab (same layout).
 */
export async function readProfileHeaderWords(data: Buffer, width: number, height: number, channels: number): Promise<OcrWord[]> {
    const top = Math.round(height * HEADER_REGION.top);
    const headerWidth = Math.round(width * HEADER_REGION.width);
    const header = await sharp(data, { raw: { width, height, channels: channels as 1 | 2 | 3 | 4 } }).extract({
        left: 0, top, width: headerWidth, height: Math.round(height * HEADER_REGION.height),
    }).png().toBuffer();
    // darkText doubles small images: map back to screenshot pixels.
    const factor = headerWidth < 600 ? 2 : 1;
    return (await recognizeWords(await darkText(header), 0)).map((word) => ({
        ...word, x: word.x / factor, y: word.y / factor + top, width: word.width / factor, height: word.height / factor,
    }));
}

/** Reads a creator's profile off a screenshot (light mode), or undefined when it isn't one. Points. */
export async function readProfileScreenshot(screenshot: Buffer, scale: number): Promise<ProfileScreen | undefined> {
    const { data, info } = await sharp(screenshot).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    const read = profileHeaderFromWords(await readProfileHeaderWords(data, width, height, channels));
    if (!read.profile) return undefined;

    const button = findFollowButton(data, width, height, channels);
    const following = !button && read.following;
    // The grid starts below the button row (or below where it would be).
    const fromY = Math.round(button ? button.y + height * 0.04 : height * 0.3);
    const tileHeight = (width / 3) * TILE_ASPECT;
    const gridTop = findGridTop(data, width, height, channels, fromY, Math.round(tileHeight * 0.3));
    const videos: Point[] = [];
    if (gridTop !== undefined && gridTop + tileHeight <= height - 80 * scale) {
        for (const column of [1, 3, 5]) {
            videos.push({ x: Math.round((width * column) / 6 / scale), y: Math.round((gridTop + tileHeight / 2) / scale) });
        }
    }
    return {
        ...(read.handle ? { handle: read.handle } : {}),
        ...(button ? { follow: { x: Math.round(button.x / scale), y: Math.round(button.y / scale) } } : {}),
        following, videos,
    };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const between = (min: number, max: number) => Math.round(min + Math.random() * (max - min));

/** The profile, read off screenshots until it shows (or the time runs out). Undefined = not on a profile. */
async function waitForProfile(context: AppContext, timeoutMs: number): Promise<ProfileScreen | undefined> {
    const until = Date.now() + timeoutMs;
    do {
        const profile = await readProfileScreenshot(await context.screenshot(), context.scale).catch(() => undefined);
        if (profile) return profile;
        await sleep(500);
    } while (Date.now() < until);
    return undefined;
}

export interface ProfileFollowDeps {
    /** The feed's rail is on screen (the profile's player has one too: the tab bar is checked as well). */
    railVisible(): Promise<boolean>;
    /** A quick swipe up, as on the feed. */
    swipeUp(): Promise<void>;
}

async function onFeed(context: AppContext, deps: ProfileFollowDeps): Promise<boolean> {
    return (await readBottomBar(await context.screenshot())) === 'feed' && deps.railVisible();
}

/**
 * From a feed video: opens the creator's profile (their name), follows, watches
 * one or two of their videos, and goes back to the feed. Throws when it
 * couldn't follow (and is back on the feed); throws AppStuckError when the
 * feed can't be confirmed.
 */
export async function followFromProfile(context: AppContext, deps: ProfileFollowDeps): Promise<{ verified: boolean; profileVideos: number; durationMs: number }> {
    const started = Date.now();
    const name = await findCreatorName(await context.screenshot(), context.scale);
    if (!name) throw new Error('could not read the creator\'s name in the caption');
    await tapCoordinate(context.driver, name.x, name.y, 'Creator name', { radius: 3 });
    await sleep(1500);
    let profile = await waitForProfile(context, 6000);
    if (!profile) {
        // Not a profile: maybe nothing happened (still on the feed), maybe another page opened.
        if (await onFeed(context, deps)) throw new Error('tapping the creator\'s name did not open their profile');
        throw new AppStuckError('Tapped the creator\'s name but neither their profile nor the feed is on screen');
    }

    let verified = false;
    let profileVideos = 0;
    try {
        // A look at the profile first, like a person deciding.
        await sleep(between(1200, 3000));
        const who = profile.handle ?? 'the creator';
        if (profile.following) throw new Error(`already following ${who}`);
        if (!profile.follow) throw new Error(`no Suivre button on ${who}'s profile`);
        await tapCoordinate(context.driver, profile.follow.x, profile.follow.y, 'Suivre', { radius: 6 });
        await sleep(1500);
        const after = await waitForProfile(context, 4000);
        verified = Boolean(after?.following);
        // Following moves the grid down (a "Comptes suggérés" strip opens above it).
        if (after) profile = after;

        // One or two of their videos.
        const tile = profile.videos.slice(0, 3)[Math.floor(Math.random() * Math.min(3, profile.videos.length))];
        if (tile) {
            await sleep(between(600, 1800));
            await tapCoordinate(context.driver, tile.x, tile.y, 'Profile video', { radius: 12 });
            const wanted = Math.random() < 0.5 ? 1 : 2;
            for (let video = 1; video <= wanted; video++) {
                if (video > 1) await deps.swipeUp();
                await sleep(between(6000, 16000));
                profileVideos = video;
            }
            // The player's "<" (its tree hangs): only tapped while the comment bar
            // shows it's the player, never on the feed (LIVE is in that spot).
            for (let attempt = 1; attempt <= 3; attempt++) {
                if ((await readBottomBar(await context.screenshot())) !== 'player') break;
                await tapCoordinate(context.driver, 22, 70, `Player back (attempt ${attempt})`, { radius: 3 });
                await sleep(1800);
            }
        }
    } finally {
        await backToFeed(context, deps);
    }
    return { verified, profileVideos, durationMs: Date.now() - started };
}

/**
 * From the profile back to the feed. The "<" is only tapped while a fresh
 * screenshot shows the profile (the feed's LIVE button is in the same spot),
 * and a second tap waits for the profile to show twice: the app lags here.
 * The feed is confirmed by its tab bar and rail.
 */
async function backToFeed(context: AppContext, deps: ProfileFollowDeps): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
        if (await onFeed(context, deps)) return;
        if (!(await readProfileScreenshot(await context.screenshot(), context.scale).catch(() => undefined))) break;
        if (attempt > 1) {
            await sleep(1000);
            if (!(await readProfileScreenshot(await context.screenshot(), context.scale).catch(() => undefined))) break;
        }
        await tapCoordinate(context.driver, PROFILE_BACK.x, PROFILE_BACK.y, `Profile back (attempt ${attempt})`, { radius: 4 });
        await sleep(2000);
    }
    for (let check = 0; check < 3; check++) {
        if (await onFeed(context, deps)) return;
        await sleep(1200);
    }
    throw new AppStuckError('Could not get back to the feed from the creator\'s profile');
}
