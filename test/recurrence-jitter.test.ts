import assert from 'node:assert/strict';
import test from 'node:test';

import { RECURRING_JITTER_MS, initialRunAt, latestDueOccurrence } from '../src/scheduler/recurrence.js';
import type { ScheduleTiming } from '../src/types.js';

const daily: ScheduleTiming = { kind: 'daily', localTime: '09:00', timezone: 'UTC' };
const fixed = (value: number) => () => value;

test('initialRunAt lands within an hour of the next slot, and the bounds are reached', () => {
    const now = new Date('2026-11-27T06:00:00Z');
    const slot = new Date('2026-11-27T09:00:00Z');
    assert.equal(initialRunAt(daily, now, fixed(0.5)).getTime(), slot.getTime());
    assert.equal(initialRunAt(daily, now, fixed(0)).getTime(), slot.getTime() - RECURRING_JITTER_MS);
    assert.ok(Math.abs(initialRunAt(daily, now, fixed(0.999999)).getTime() - (slot.getTime() + RECURRING_JITTER_MS)) < 1_000);
});

test('every jittered run stays within an hour of its slot across many draws', () => {
    const now = new Date('2026-11-27T06:00:00Z');
    const slot = new Date('2026-11-27T09:00:00Z').getTime();
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
        const at = initialRunAt(daily, now).getTime();
        assert.ok(Math.abs(at - slot) <= RECURRING_JITTER_MS, `offset out of range: ${at - slot}`);
        seen.add(at);
    }
    assert.ok(seen.size > 100, 'start times should vary, not repeat');
});

test('a jittered run that fires early does not re-run the same slot', () => {
    // Slot is 09:00; fire was jittered to 08:10 and the worker picks it up at 08:20.
    const stored = new Date('2026-11-27T08:10:00Z');
    const now = new Date('2026-11-27T08:20:00Z');
    const due = latestDueOccurrence(daily, stored, now, fixed(0.5));
    assert.ok(due);
    assert.equal(due.scheduledFor.getTime(), stored.getTime());
    const nextSlot = new Date('2026-11-28T09:00:00Z').getTime();
    assert.equal(due.nextRunAt?.getTime(), nextSlot);
});

test('a jittered run that fires late moves on to the next day', () => {
    const stored = new Date('2026-11-27T09:50:00Z');
    const now = new Date('2026-11-27T09:55:00Z');
    const due = latestDueOccurrence(daily, stored, now, fixed(0.5));
    assert.ok(due?.nextRunAt);
    assert.ok(Math.abs(due.nextRunAt.getTime() - new Date('2026-11-28T09:00:00Z').getTime()) <= RECURRING_JITTER_MS);
});

test('nothing is due before the stored fire time', () => {
    const stored = new Date('2026-11-27T09:40:00Z');
    assert.equal(latestDueOccurrence(daily, stored, new Date('2026-11-27T09:30:00Z')), null);
});

test('after a long outage only the newest missed slot runs', () => {
    const stored = new Date('2026-11-25T09:20:00Z');
    const now = new Date('2026-11-27T10:00:00Z');
    const due = latestDueOccurrence(daily, stored, now, fixed(0.5));
    assert.equal(due?.scheduledFor.getTime(), new Date('2026-11-27T09:00:00Z').getTime());
});

test('existing unjittered schedules keep working', () => {
    const stored = new Date('2026-11-27T09:00:00Z');
    const due = latestDueOccurrence(daily, stored, new Date('2026-11-27T09:00:05Z'), fixed(0.5));
    assert.equal(due?.scheduledFor.getTime(), stored.getTime());
});
