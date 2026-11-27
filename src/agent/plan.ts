// What the agent (a Claude Code session) decides for one video, and how that
// decision becomes concrete, humanized timings. Kept free of device code so
// it can be unit-tested.

import { PROFILES, type Personality } from '../tiktok/doomscroll-profile.js';
import { COMMENT_KEEP_CHANCE, commentChance, commentOpen, sanitizeComment } from './comment.js';

export type WatchChoice = 'skip' | 'short' | 'full';

export interface AgentPlan {
    /** 0..1: how sure the agent is that the video is on-niche. */
    onNiche: number;
    watch: WatchChoice;
    /** When to like, in ms from now. Undefined/null = don't like. */
    likeAtMs?: number | null;
    save?: boolean;
    /** Text to leave as a comment (apps that support it). Undefined/null = no comment. */
    comment?: string | null;
    /** Follow the creator after watching (warm-up sessions that follow). */
    follow?: boolean;
}

/**
 * `watchMs` counts from the moment the video appeared on screen (the swipe
 * landing): capture and the model's thinking time already count as watching,
 * so a slow model doesn't stretch every video. The action times (like, save,
 * comment) count from the decision, like a person reacting once they've made
 * up their mind; the session stretches the watch when one lands past it.
 */
export interface TimedPlan {
    /** How long the video stays on screen in total before swiping. */
    watchMs: number;
    /** Undefined = no like. Always <= watchMs (both counted from 0, see above). */
    likeAtMs?: number;
    /** Undefined = no save. Always <= watchMs and after likeAtMs. */
    saveAtMs?: number;
    /** Undefined = no comment. After the like; the watch stretches past it. */
    commentAtMs?: number;
    /** The comment as it will be typed (sanitized). Set with commentAtMs. */
    comment?: string;
}

/**
 * Target time on screen in ms per personality, counted from the swipe landing,
 * so capture and the agent's thinking time are part of it. When the decision
 * arrives after the target, the swipe follows right away. Skip is how long a
 * person takes to see "not for me" and flick away. Short/full follow the
 * programmatic profiles' watch and linger ranges so a session stays in its
 * category. `full` is used until TikTok's progress bar can be read.
 */
export const WATCH_RANGES: Record<Personality, Record<WatchChoice, [number, number]>> = {
    skimmer: { skip: [800, 2500], short: [1000, 3000], full: [4000, 9000] },
    casual: { skip: [800, 2500], short: [2000, 6000], full: [8000, 15000] },
    engaged: { skip: [800, 2500], short: [5000, 12000], full: [15000, 28000] },
};

/**
 * Longest a `full` watch follows the progress bar before swiping anyway, so a
 * multi-minute video doesn't eat the session. Without a bar, `full` uses
 * WATCH_RANGES instead.
 */
export const FULL_WATCH_CAP_MS: Record<Personality, number> = {
    skimmer: 20_000,
    casual: 60_000,
    engaged: 120_000,
};

/** Likes/saves/comments done and videos judged so far in the session. */
export interface EngagementSoFar {
    judged: number;
    likes: number;
    saves: number;
    comments?: number;
    /** Videos judged when the last comment was left. */
    lastCommentAt?: number;
}

/**
 * Whether one more like (or save) keeps the session at or under the
 * personality's rate: at most chance × videos-judged-including-this-one,
 * rounded, and always at least one so an early on-niche video can be liked.
 */
export function withinBudget(done: number, judgedIncludingThis: number, chance: number): boolean {
    return done < engagementAllowance(judgedIncludingThis, chance);
}

/** How many likes (or saves) the rate allows once this many videos are judged. */
export function engagementAllowance(judgedIncludingThis: number, chance: number): number {
    return Math.max(1, Math.round(chance * judgedIncludingThis));
}

/** The model is repetitive; the code drops a planned like/save this often. */
export const ENGAGEMENT_DROP_CHANCE = 0.1;

/** Like/save timings move by up to this share either way. */
const TIMING_JITTER = 0.25;

/** Minimum gap between a like and a save, and before the swipe. */
export const MIN_ACTION_GAP_MS = 700;

function between(min: number, max: number, random: () => number): number {
    return Math.round(min + random() * (max - min));
}

function jitter(value: number, random: () => number): number {
    return Math.round(value * (1 - TIMING_JITTER + random() * 2 * TIMING_JITTER));
}

/**
 * Turns a plan into timings. Skipped videos are never liked, saved or commented. The
 * session deadline doesn't shorten a video: it only decides whether another
 * one starts, so the last video plays out like any other.
 */
export function timePlan(
    plan: AgentPlan,
    personality: Personality = 'casual',
    soFar: EngagementSoFar = { judged: 0, likes: 0, saves: 0 },
    random: () => number = Math.random,
): TimedPlan {
    const [min, max] = WATCH_RANGES[personality][plan.watch];
    let watchMs = between(min, max, random);
    if (plan.watch === 'skip') return { watchMs };

    // The agent picks which videos deserve a like/save; the personality caps
    // how many, so a session reads as skimmer/casual/engaged.
    const profile = PROFILES[personality];
    const judged = soFar.judged + 1;
    let likeAtMs: number | undefined;
    if (plan.likeAtMs !== undefined && plan.likeAtMs !== null && random() >= ENGAGEMENT_DROP_CHANCE
        && withinBudget(soFar.likes, judged, profile.likeChance)) {
        likeAtMs = jitter(Math.max(0, plan.likeAtMs), random);
    }
    let saveAtMs: number | undefined;
    if (plan.save && random() >= ENGAGEMENT_DROP_CHANCE && withinBudget(soFar.saves, judged, profile.saveChance)) {
        // Saving usually happens once the viewer has decided they like it.
        const after = (likeAtMs ?? 0) + MIN_ACTION_GAP_MS;
        saveAtMs = Math.max(after, between(Math.round(watchMs * 0.4), Math.round(watchMs * 0.8), random));
    }
    let commentAtMs: number | undefined;
    const comment = sanitizeComment(plan.comment);
    if (comment && plan.watch === 'full' && random() < COMMENT_KEEP_CHANCE
        && commentOpen(judged, soFar.comments ?? 0, soFar.lastCommentAt, commentChance(personality))) {
        // People comment once they've watched a bit (and liked, if they did).
        commentAtMs = Math.max((likeAtMs ?? 0) + MIN_ACTION_GAP_MS, between(3000, 9000, random));
    }
    // A planned action must fit before the swipe: stretch the watch for it.
    const lastAction = Math.max(likeAtMs ?? -Infinity, saveAtMs ?? -Infinity, commentAtMs ?? -Infinity);
    if (Number.isFinite(lastAction)) watchMs = Math.max(watchMs, lastAction + MIN_ACTION_GAP_MS);
    return {
        watchMs,
        ...(likeAtMs !== undefined ? { likeAtMs } : {}),
        ...(saveAtMs !== undefined ? { saveAtMs } : {}),
        ...(commentAtMs !== undefined && comment ? { commentAtMs, comment } : {}),
    };
}

/** A like or save tied to how far a `full` video has played (0-1 of its progress bar). */
export interface ProgressReaction {
    kind: 'like' | 'save';
    atProgress: number;
}

/** Where in a video likes land, as a share of its length. */
export const LIKE_PROGRESS: [number, number] = [0.3, 0.75];
/** Saves land here, and at least this far after the like. */
export const SAVE_PROGRESS: [number, number] = [0.5, 0.85];
const SAVE_AFTER_LIKE = 0.15;
const LAST_REACTION_PROGRESS = 0.95;

/**
 * For a `full` watch on a video with a progress bar: like and save at a point
 * in the video rather than a number of seconds, so they land while it plays
 * however long it is (not after the end of a short one). Only which actions
 * survived `timePlan` is used, not its times.
 */
export function reactionPoints(timed: Pick<TimedPlan, 'likeAtMs' | 'saveAtMs'>, random: () => number = Math.random): ProgressReaction[] {
    const points: ProgressReaction[] = [];
    const share = ([lo, hi]: [number, number]) => lo + random() * (hi - lo);
    let likeAt: number | undefined;
    if (timed.likeAtMs !== undefined) {
        likeAt = share(LIKE_PROGRESS);
        points.push({ kind: 'like', atProgress: likeAt });
    }
    if (timed.saveAtMs !== undefined) {
        const saveAt = Math.max(share(SAVE_PROGRESS), (likeAt ?? 0) + SAVE_AFTER_LIKE);
        points.push({ kind: 'save', atProgress: Math.min(saveAt, LAST_REACTION_PROGRESS) });
    }
    return points;
}

/** A session lasts the asked minutes give or take this share, so runs don't all end on the minute. */
const SESSION_LENGTH_JITTER = 0.15;

/** Session length in ms for `--minutes`: e.g. 10 min becomes anything from 8.5 to 11.5 min. */
export function sessionLengthMs(minutes: number, random: () => number = Math.random): number {
    return Math.round(minutes * 60_000 * (1 - SESSION_LENGTH_JITTER + random() * 2 * SESSION_LENGTH_JITTER));
}

/** How long the last video stays on screen after its plan is done, before the app closes (no swipe). */
export function finalLingerMs(random: () => number = Math.random): number {
    return between(1500, 5000, random);
}

/** TikTok Shop posts: a product card sits where the normal swipe starts, and they are never on-niche. */
export const SHOP_POST = /commission\s*pay|paid\s*commission|tiktok\s*shop/i;

/** Why a video is skipped in code without asking the model, if it is. */
export function autoSkipReason(video: { isAd: boolean; caption: string }): 'ad' | 'shop' | undefined {
    if (video.isAd) return 'ad';
    if (SHOP_POST.test(video.caption)) return 'shop';
    return undefined;
}

function captionTokens(caption: string): Set<string> {
    return new Set(caption.toLowerCase().normalize('NFD').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((token) => token.length >= 3));
}

/**
 * Whether two OCR'd captions are the same video: most of their words match.
 * Too little text to tell counts as different.
 */
export function sameCaption(a: string, b: string): boolean {
    const left = captionTokens(a);
    const right = captionTokens(b);
    if (left.size < 4 || right.size < 4) return false;
    let shared = 0;
    for (const token of left) if (right.has(token)) shared += 1;
    return shared / (left.size + right.size - shared) >= 0.75;
}

/** One swipe as written to decisions.jsonl: where the finger went, in points. */
export interface SwipeRecord {
    /** 'right-thumb' etc. for a recorded style, 'fixed' or 'ad' for the coordinate swipe. */
    style: string;
    from: { x: number; y: number };
    to: { x: number; y: number };
    /** Upward distance (from.y - to.y). */
    dy: number;
    ms: number;
}

export function swipeRecord(style: string, swipe: { start: { x: number; y: number }; end: { x: number; y: number }; durationMs: number }): SwipeRecord {
    return {
        style,
        from: { x: swipe.start.x, y: swipe.start.y },
        to: { x: swipe.end.x, y: swipe.end.y },
        dy: swipe.start.y - swipe.end.y,
        ms: swipe.durationMs,
    };
}
