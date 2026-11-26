// Comments left from the agentic doomscroll: how many a session may leave,
// and turning the model's text into something the on-screen keyboard can
// type. Kept free of device code so it can be unit-tested.

import type { Personality } from '../tiktok/doomscroll-profile.js';

/**
 * Share of judged videos a viewer comments on. Far rarer than likes: most
 * people never comment, and a fresh account that comments a lot looks like
 * a bot. AGENT_COMMENT_CHANCE (0-1) overrides it for every personality.
 */
export const COMMENT_CHANCE: Record<Personality, number> = {
    skimmer: 0,
    casual: 0.03,
    engaged: 0.06,
};

/** Hard cap per session, whatever the rate. */
export const MAX_COMMENTS_PER_SESSION = 3;

/** Judged videos between two comments at least, so they never come in a row. */
export const MIN_VIDEOS_BETWEEN_COMMENTS = 12;

/**
 * Minutes of scrolling before the first comment of a session: people watch a
 * while before they write anything. AGENT_COMMENT_WARMUP_MIN overrides it.
 */
export function commentWarmupMs(): number {
    const raw = process.env.AGENT_COMMENT_WARMUP_MIN;
    if (raw === undefined || raw === '') return 5 * 60_000;
    const minutes = Number(raw);
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > 120) {
        throw new Error(`AGENT_COMMENT_WARMUP_MIN must be a number of minutes between 0 and 120; received ${raw}`);
    }
    return Math.round(minutes * 60_000);
}

/**
 * Share of the model's comments that are kept even when one is allowed: the
 * model writes one on the first fitting video, which would land every comment
 * the moment the allowance opens. Dropping most spreads them out.
 */
export const COMMENT_KEEP_CHANCE = 0.35;

/** Comments are short, like ones typed with a thumb under a Reel. */
export const MAX_COMMENT_LENGTH = 120;
const MIN_COMMENT_LENGTH = 2;

export function commentChance(personality: Personality): number {
    const raw = process.env.AGENT_COMMENT_CHANCE;
    if (raw === undefined || raw === '') return COMMENT_CHANCE[personality];
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error(`AGENT_COMMENT_CHANCE must be a number between 0 and 1; received ${raw}`);
    }
    return value;
}

/**
 * How many comments the rate allows once this many videos are judged.
 * Unlike likes there is no free first one: with the default rates the first
 * comment comes after a dozen or more videos.
 */
export function commentAllowance(judgedIncludingThis: number, chance: number): number {
    return Math.min(MAX_COMMENTS_PER_SESSION, Math.round(chance * judgedIncludingThis));
}

/**
 * Whether the video being judged may get a comment: the rate allows one more,
 * and enough videos went by since the last one. `lastCommentAt` is the judged
 * count when the last comment was left.
 */
export function commentOpen(judgedIncludingThis: number, comments: number, lastCommentAt: number | undefined, chance: number): boolean {
    if (comments >= commentAllowance(judgedIncludingThis, chance)) return false;
    return lastCommentAt === undefined || judgedIncludingThis - lastCommentAt >= MIN_VIDEOS_BETWEEN_COMMENTS;
}

/**
 * Makes a comment read like a quick text message and typeable on the
 * on-screen keyboard, or returns undefined when nothing usable is left:
 * all lowercase, no punctuation at all (apostrophes included: "jadore"),
 * no accents (é needs a long-press the typing engine doesn't do), no emojis,
 * hashtags, mentions or links. One line only: return would post the comment
 * early. Cut at a word near the limit.
 */
export function sanitizeComment(text: string | null | undefined): string | undefined {
    if (!text) return undefined;
    let clean = text
        .normalize('NFD').replace(/\p{M}/gu, '')
        .replace(/œ/g, 'oe').replace(/Œ/g, 'Oe').replace(/æ/g, 'ae').replace(/Æ/g, 'Ae').replace(/ß/g, 'ss')
        .replace(/[’‘]/g, "'").replace(/[“”«»]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...')
        .replace(/https?:\/\/\S+|www\.\S+/gi, ' ')
        .replace(/[#@]\S*/g, ' ')
        .toLowerCase()
        // Apostrophes join their words, like people text ("jadore", "cest").
        .replace(/'/g, '')
        // Only letters, digits and spaces.
        .replace(/[^a-z0-9 ]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (clean.length > MAX_COMMENT_LENGTH) {
        const cut = clean.slice(0, MAX_COMMENT_LENGTH + 1);
        const lastSpace = cut.lastIndexOf(' ');
        clean = (lastSpace > MAX_COMMENT_LENGTH * 0.6 ? cut.slice(0, lastSpace) : cut.slice(0, MAX_COMMENT_LENGTH)).trim();
    }
    if (clean.length < MIN_COMMENT_LENGTH) return undefined;
    return clean;
}

/** The app is left on a screen the session can't go on from (e.g. a comment sheet that won't close). Stops the session. */
export class AppStuckError extends Error {}
