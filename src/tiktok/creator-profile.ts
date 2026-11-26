// Following a TikTok creator from their profile, for the warm-up. Worked out
// on the French iOS app on an iPhone XR (2026-11):
//
//   Feed: tapping the creator's name (the bold first line of the caption,
//   bottom left) opens their profile. The avatar is avoided: a ring around it
//   (a story) can open the story instead.
//   Profile: its accessibility tree reads fine. The big "Suivre" button sits
//   in `cta_social_interaction`; after following it becomes "Message" plus a
//   "Suivis ▾" button (`cta_settings_button`). Following can open a "Comptes
//   suggérés" strip with its own "Suivre" buttons: never tap those. Video
//   tiles are Buttons labelled "… Vidéo. N vues.".
//   A tile opens a player (its page source hangs, like the feed) with "<" at
//   the top left; a quick swipe up shows the creator's next video.
//   Back: player "<" → profile; profile `nav_bar_start_back` → feed. The app
//   lags here: a screenshot can still show the profile after going back, and
//   the feed's LIVE button sits exactly where the profile's back arrow was.
//   So every back tap is guarded by reading the tree first.

import sharp from 'sharp';

import { AppStuckError } from '../agent/comment.js';
import { readSource } from '../agent/page-source.js';
import type { AppContext } from '../agent/session.js';
import type { SourceNode } from '../instagram/reels-screen.js';
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

const clean = (text: string | null | undefined) => (text ?? '').replace(/[  ‎⁨⁩]/g, ' ').trim();
const isVisible = (node: SourceNode) => node.isVisible === undefined || node.isVisible === true || node.isVisible === '1';
const isButton = (node: SourceNode) => node.type === 'Button' || node.type === 'XCUIElementTypeButton';

function all(root: SourceNode, match: (node: SourceNode) => boolean): SourceNode[] {
    const found: SourceNode[] = [];
    const stack = [root];
    while (stack.length) {
        const node = stack.pop()!;
        if (match(node) && isVisible(node)) found.push(node);
        for (const child of [...(node.children ?? [])].reverse()) stack.push(child);
    }
    return found;
}

function centre(node: SourceNode): Point | undefined {
    const rect = node.rect;
    if (!rect || rect.width <= 0 || rect.height <= 0) return undefined;
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
}

function inside(point: Point, node: SourceNode | undefined): boolean {
    const rect = node?.rect;
    return Boolean(rect && point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height);
}

export interface ProfileScreen {
    handle: string;
    /** The big Follow button (never a suggested account's). */
    follow?: Point;
    /** "Message" / "Suivis ▾" show: this account already follows the creator. */
    following: boolean;
    back?: Point;
    /** Video tiles fully on screen, top to bottom. */
    videos: Point[];
}

/** Reads a creator's profile from its accessibility tree, or undefined when it isn't one. */
export function readProfileScreen(root: SourceNode, screenHeight: number): ProfileScreen | undefined {
    const handleNode = all(root, (n) => n.name === 'user_account_user_name')[0];
    const handle = clean(handleNode?.label ?? handleNode?.value);
    if (!handle) return undefined;
    const cta = all(root, (n) => n.name === 'cta_social_interaction')[0];
    const followNode = all(root, (n) => isButton(n) && /^(Suivre|Follow)$/i.test(clean(n.label)))
        .find((n) => { const point = centre(n); return point !== undefined && inside(point, cta); });
    const following = all(root, (n) => n.name === 'cta_settings_button' || (isButton(n) && /^Message$/i.test(clean(n.label))))
        .some((n) => { const point = centre(n); return point !== undefined && (!cta || inside(point, cta) || n.name === 'cta_settings_button'); });
    const backNode = all(root, (n) => n.name === 'nav_bar_start_back')[0];
    const videos = all(root, (n) => isButton(n) && /Vid[ée]o\. [\d\s.,]+ (vues|views)\.?$/i.test(clean(n.label)))
        .filter((n) => n.rect && n.rect.y >= 0 && n.rect.y + n.rect.height <= screenHeight - 90)
        .map(centre).filter((point): point is Point => point !== undefined)
        .sort((a, b) => a.y - b.y || a.x - b.x);
    const follow = followNode && centre(followNode);
    const back = backNode && centre(backNode);
    return {
        handle: handle.startsWith('@') ? handle : `@${handle}`,
        ...(follow ? { follow } : {}), following, ...(back ? { back } : {}), videos,
    };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const between = (min: number, max: number) => Math.round(min + Math.random() * (max - min));

/** The profile, read again until it shows (or the time runs out). Undefined = not on a profile (or the tree hangs). */
async function waitForProfile(context: AppContext, timeoutMs: number): Promise<ProfileScreen | undefined> {
    const until = Date.now() + timeoutMs;
    do {
        const tree = await readSource(context, 6000).catch(() => undefined);
        const profile = tree && readProfileScreen(tree, context.window.height);
        if (profile) return profile;
        await sleep(700);
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
        if (profile.following) throw new Error(`already following ${profile.handle}`);
        if (!profile.follow) throw new Error(`no Suivre button on ${profile.handle}'s profile`);
        await tapCoordinate(context.driver, profile.follow.x, profile.follow.y, 'Suivre', { radius: 6 });
        await sleep(1500);
        profile = (await waitForProfile(context, 4000)) ?? profile;
        verified = profile.following;

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
 * From the profile back to the feed. The back arrow is only tapped when the
 * tree shows it (the feed's LIVE button is in the same spot); the feed is
 * confirmed by its rail.
 */
async function backToFeed(context: AppContext, deps: ProfileFollowDeps): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
        const profile = await waitForProfile(context, 3000);
        if (!profile) break;
        if (!profile.back) throw new AppStuckError(`No back button on ${profile.handle}'s profile`);
        await tapCoordinate(context.driver, profile.back.x, profile.back.y, `Profile back (attempt ${attempt})`, { radius: 4 });
        await sleep(2000);
    }
    for (let check = 0; check < 3; check++) {
        if (await onFeed(context, deps)) return;
        await sleep(1200);
    }
    throw new AppStuckError('Could not get back to the feed from the creator\'s profile');
}
