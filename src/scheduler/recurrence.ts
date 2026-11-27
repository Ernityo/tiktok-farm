import { CronExpressionParser } from 'cron-parser';

import type { ScheduleTiming } from '../types.js';

const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function cronFor(timing: Extract<ScheduleTiming, { kind: 'daily' | 'weekly' }>): string {
    if (!TIME_PATTERN.test(timing.localTime)) throw new Error('localTime must use HH:mm');
    const [hour, minute] = timing.localTime.split(':').map(Number);
    if (timing.kind === 'daily') return `${minute} ${hour} * * *`;
    const weekdays = [...new Set(timing.weekdays)].sort();
    if (!weekdays.length || weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
        throw new Error('weekly schedules require weekdays numbered 0 through 6');
    }
    return `${minute} ${hour} * * ${weekdays.join(',')}`;
}

function parseRecurring(timing: Extract<ScheduleTiming, { kind: 'daily' | 'weekly' }>, currentDate: Date) {
    try {
        return CronExpressionParser.parse(cronFor(timing), { currentDate, tz: timing.timezone });
    } catch (error) {
        throw new Error(`Invalid recurring schedule: ${error instanceof Error ? error.message : String(error)}`);
    }
}

export function validateTiming(timing: ScheduleTiming, now = new Date()): void {
    if (timing.kind === 'now') return;
    if (timing.kind === 'once') {
        const runAt = new Date(timing.runAt);
        if (!Number.isFinite(runAt.getTime())) throw new Error('runAt must be an ISO timestamp');
        if (runAt.getTime() < now.getTime() - 60_000) throw new Error('runAt cannot be in the past');
        return;
    }
    void parseRecurring(timing, now).next();
}

// Recurring runs fire up to this far before or after their cron slot, so they don't start at the same minute every day.
// One-off (`once`) and `now` runs are never jittered.
export const RECURRING_JITTER_MS = 60 * 60_000;

type Random = () => number;

function withJitter(slot: Date, random: Random): Date {
    const offset = Math.round((random() * 2 - 1) * RECURRING_JITTER_MS);
    return new Date(slot.getTime() + offset);
}

// The cron slot a stored fire time belongs to. Fire times sit within RECURRING_JITTER_MS of their slot and slots are
// at least a day apart, so the first slot after (fire time - 2h) is always the one it belongs to.
function slotFor(timing: Extract<ScheduleTiming, { kind: 'daily' | 'weekly' }>, fireAt: Date): Date {
    return parseRecurring(timing, new Date(fireAt.getTime() - 2 * RECURRING_JITTER_MS)).next().toDate();
}

export function initialRunAt(timing: ScheduleTiming, now = new Date(), random: Random = Math.random): Date {
    if (timing.kind === 'now') return now;
    if (timing.kind === 'once') return new Date(timing.runAt);
    const slot = parseRecurring(timing, new Date(now.getTime() - 1_000)).next().toDate();
    return withJitter(slot, random);
}

export function latestDueOccurrence(
    timing: ScheduleTiming,
    storedNextRunAt: Date,
    now = new Date(),
    random: Random = Math.random,
): { scheduledFor: Date; nextRunAt: Date | null } | null {
    if (storedNextRunAt > now) return null;
    if (timing.kind === 'now' || timing.kind === 'once') {
        return { scheduledFor: storedNextRunAt, nextRunAt: null };
    }
    const storedSlot = slotFor(timing, storedNextRunAt);
    const latestSlot = parseRecurring(timing, new Date(now.getTime() + 1_000)).prev().toDate();
    // If the worker was down past a whole slot, run the newest missed slot instead of the stale fire time.
    const scheduledFor = latestSlot > storedSlot ? latestSlot : storedNextRunAt;
    // Never pick the slot we just ran (or one already passed) as the next one.
    const after = new Date(Math.max(now.getTime(), storedSlot.getTime()));
    const nextSlot = parseRecurring(timing, after).next().toDate();
    return { scheduledFor, nextRunAt: withJitter(nextSlot, random) };
}
