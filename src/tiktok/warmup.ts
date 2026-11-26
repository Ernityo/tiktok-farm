import type { JsonObject, JsonValue, RegisteredDevice } from '@git-agni/phone-farm-core';

import { normalizeHandle } from './niche.js';
import { TIKTOK_PLUGIN_ID } from './runtime-settings.js';

/**
 * Warm-up of a fresh TikTok account, three short agentic sessions a day
 * (morning, noon, evening), never commenting:
 *
 *   days 1-2  persona: the feed learns who the person is (their broad,
 *             everyday interests from the niche's `persona`).
 *   days 3-5  niche: the feed is pulled to the niche. Once a day the session
 *             scrolls For You 1-5 min, searches a niche keyword, watches some
 *             results, then goes back to For You. Aim: ~70% of For You videos
 *             on-niche by the end of day 5.
 *   day 6+    done: plain niche sessions (no search).
 *
 * Both phases follow ~5 creators per session that fit what is being taught.
 * The start day (in the timezone the warm-up was started in) is stored per
 * account under `pluginData["com.git-agni.tiktok"].warmups["@handle"]`.
 */
export interface WarmupState {
    /** Day 1 of the warm-up, YYYY-MM-DD in `timezone`. */
    startedOn: string;
    /** IANA timezone the days are counted in. */
    timezone: string;
}

export type WarmupPhase = 'persona' | 'niche' | 'done';

export const WARMUP_PLAN = {
    personaDays: 2,
    nicheDays: 3,
    /** On-niche share of For You videos the niche phase aims for by its last day. */
    targetOnNicheShare: 0.7,
    followsPerSession: 5,
} as const;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function validTimezone(timezone: string): boolean {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone });
        return true;
    } catch {
        return false;
    }
}

/** The calendar date (YYYY-MM-DD) of `now` in `timezone`. */
export function localDate(now: Date, timezone: string): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/**
 * Day 1 of a warm-up started at `now` with sessions at `times` (HH:MM): today
 * while the first session of the day is still ahead, else tomorrow, so day 1
 * gets all its sessions.
 */
export function warmupStartDate(now: Date, timezone: string, times: readonly string[]): string {
    const today = localDate(now, timezone);
    const clock = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
    const first = [...times].sort()[0];
    if (!first || clock < first) return today;
    return new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

function dayNumber(date: string): number {
    return Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
}

/** 1 on the start day, 2 the next calendar day, ... (0 or less before it). */
export function warmupDay(state: WarmupState, now = new Date()): number {
    return dayNumber(localDate(now, state.timezone)) - dayNumber(state.startedOn) + 1;
}

export function warmupPhase(day: number): WarmupPhase {
    if (day <= WARMUP_PLAN.personaDays) return 'persona';
    if (day <= WARMUP_PLAN.personaDays + WARMUP_PLAN.nicheDays) return 'niche';
    return 'done';
}

export function parseWarmup(value: JsonValue | undefined): WarmupState {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Warm-up must be an object');
    const { startedOn, timezone } = value;
    if (typeof startedOn !== 'string' || !DATE.test(startedOn) || Number.isNaN(Date.parse(startedOn))) {
        throw new Error('Warm-up startedOn must be a YYYY-MM-DD date');
    }
    if (typeof timezone !== 'string' || !validTimezone(timezone)) throw new Error('Warm-up timezone must be an IANA timezone');
    return { startedOn, timezone };
}

/** Every valid warm-up on the device, keyed by "@handle". Invalid entries are skipped. */
export function accountWarmups(device: RegisteredDevice | undefined): Record<string, WarmupState> {
    const stored = device?.pluginData[TIKTOK_PLUGIN_ID]?.warmups;
    const result: Record<string, WarmupState> = {};
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return result;
    for (const [handle, value] of Object.entries(stored)) {
        try {
            result[normalizeHandle(handle)] = parseWarmup(value);
        } catch {
            // A hand-edited, broken entry shouldn't break a run.
        }
    }
    return result;
}

export function warmupForAccount(device: RegisteredDevice | undefined, handle: string): WarmupState | undefined {
    return accountWarmups(device)[normalizeHandle(handle)];
}

export function warmupsToJson(warmups: Record<string, WarmupState>): JsonObject {
    return Object.fromEntries(Object.entries(warmups).map(([handle, state]) => [handle, { startedOn: state.startedOn, timezone: state.timezone }]));
}

/** Drops warm-ups of accounts that are no longer configured on the device. */
export function pruneWarmups(warmups: Record<string, WarmupState>, accounts: readonly string[]): Record<string, WarmupState> {
    const keep = new Set(accounts.map(normalizeHandle));
    return Object.fromEntries(Object.entries(warmups).filter(([handle]) => keep.has(handle)));
}

/**
 * Follows allowed so far, paced over the session so they don't bunch up at
 * the start: the target share of the elapsed time, rounded up, and capped
 * at the target. `elapsedShare` is 0..1 of the session length.
 */
export function followAllowance(target: number, elapsedShare: number): number {
    if (target <= 0) return 0;
    return Math.min(target, Math.max(1, Math.ceil(target * Math.min(1, Math.max(0, elapsedShare)))));
}
