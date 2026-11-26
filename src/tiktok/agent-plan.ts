// What the agent (a Claude Code session) decides for one video, and how that
// decision becomes concrete, humanized timings. Kept free of device code so
// it can be unit-tested.

import { PROFILES, type Personality } from './doomscroll-profile.js';

export type WatchChoice = 'skip' | 'short' | 'full';

export interface AgentPlan {
    /** 0..1: how sure the agent is that the video is on-niche. */
    onNiche: number;
    watch: WatchChoice;
    /** When to like, in ms from now. Undefined/null = don't like. */
    likeAtMs?: number | null;
    save?: boolean;
}

export interface TimedPlan {
    /** Extra time to keep the video on screen before swiping. */
    watchMs: number;
    /** Undefined = no like. Always <= watchMs. */
    likeAtMs?: number;
    /** Undefined = no save. Always <= watchMs and after likeAtMs. */
    saveAtMs?: number;
}

/**
 * Extra watch time in ms per personality, on top of the agent's thinking time
 * (which already counts as watch time). Short/full follow the programmatic
 * profiles' watch and linger ranges so a session stays in its category.
 * `full` is used until TikTok's progress bar can be read.
 */
export const WATCH_RANGES: Record<Personality, Record<WatchChoice, [number, number]>> = {
    skimmer: { skip: [150, 450], short: [1000, 3000], full: [4000, 9000] },
    casual: { skip: [150, 450], short: [2000, 6000], full: [8000, 15000] },
    engaged: { skip: [150, 450], short: [5000, 12000], full: [15000, 28000] },
};

/** Likes/saves done and videos judged so far in the session. */
export interface EngagementSoFar {
    judged: number;
    likes: number;
    saves: number;
}

/**
 * Whether one more like (or save) keeps the session at or under the
 * personality's rate: at most chance × videos-judged-including-this-one,
 * rounded, and always at least one so an early on-niche video can be liked.
 */
export function withinBudget(done: number, judgedIncludingThis: number, chance: number): boolean {
    return done < Math.max(1, Math.round(chance * judgedIncludingThis));
}

/** The model is repetitive; the code drops a planned like/save this often. */
export const ENGAGEMENT_DROP_CHANCE = 0.1;

/** Like/save timings move by up to this share either way. */
const TIMING_JITTER = 0.25;

/** Minimum gap between a like and a save, and before the swipe. */
const MIN_ACTION_GAP_MS = 700;

function between(min: number, max: number, random: () => number): number {
    return Math.round(min + random() * (max - min));
}

function jitter(value: number, random: () => number): number {
    return Math.round(value * (1 - TIMING_JITTER + random() * 2 * TIMING_JITTER));
}

/**
 * Turns a plan into timings. Skipped videos are never liked or saved, and
 * every value is clamped so the whole thing ends by `remainingMs` (the
 * session deadline).
 */
export function timePlan(
    plan: AgentPlan,
    remainingMs: number,
    personality: Personality = 'casual',
    soFar: EngagementSoFar = { judged: 0, likes: 0, saves: 0 },
    random: () => number = Math.random,
): TimedPlan {
    const [min, max] = WATCH_RANGES[personality][plan.watch];
    let watchMs = Math.max(0, Math.min(between(min, max, random), remainingMs));
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
    // A planned action must fit before the swipe: stretch the watch for it,
    // within the session deadline.
    const lastAction = Math.max(likeAtMs ?? -Infinity, saveAtMs ?? -Infinity);
    if (Number.isFinite(lastAction)) watchMs = Math.min(Math.max(watchMs, lastAction + MIN_ACTION_GAP_MS), remainingMs);
    if (likeAtMs !== undefined && likeAtMs > watchMs) likeAtMs = undefined;
    if (saveAtMs !== undefined && saveAtMs > watchMs) saveAtMs = undefined;
    return {
        watchMs,
        ...(likeAtMs !== undefined ? { likeAtMs } : {}),
        ...(saveAtMs !== undefined ? { saveAtMs } : {}),
    };
}
