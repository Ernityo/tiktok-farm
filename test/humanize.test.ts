import assert from 'node:assert/strict';
import test from 'node:test';

import { humanSwipe, humanTap, jitterPoint, pathFromActions, type PointerAction } from '../src/devices/humanize.js';
import { planTouchGesture } from '../src/devices/wda-remote.js';

// Small deterministic PRNG so failures are reproducible.
function seeded(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function moves(actions: PointerAction[]) {
    return actions.filter((action) => action.type === 'pointerMove');
}

test('jitterPoint stays within the radius and actually varies', () => {
    const random = seeded(1);
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i += 1) {
        const point = jitterPoint({ x: 100, y: 200 }, 4, random);
        assert.ok(Math.abs(point.x - 100) <= 4 && Math.abs(point.y - 200) <= 4);
        seen.add(`${point.x},${point.y}`);
    }
    assert.ok(seen.size > 20);
});

test('humanTap presses down once near the target with a bounded hold', () => {
    const random = seeded(2);
    const holds = new Set<number>();
    for (let i = 0; i < 500; i += 1) {
        const { point, actions } = humanTap({ x: 50, y: 60 }, { radius: 3 }, random);
        assert.ok(Math.abs(point.x - 50) <= 3 && Math.abs(point.y - 60) <= 3);
        assert.equal(actions.filter((a) => a.type === 'pointerDown').length, 1);
        assert.equal(actions.at(-1)?.type, 'pointerUp');
        const hold = actions.reduce((sum, a) => sum + (a.type === 'pause' || (a.type === 'pointerMove' && a.duration) ? (a as { duration: number }).duration : 0), 0);
        assert.ok(hold >= 55 && hold <= 170, `hold ${hold}`);
        for (const move of moves(actions)) {
            assert.ok(Math.abs(move.x - 50) <= 5 && Math.abs(move.y - 60) <= 5);
        }
        holds.add(hold);
    }
    assert.ok(holds.size > 20);
});

test('humanSwipe varies endpoints, duration and path, within bounds', () => {
    const random = seeded(3);
    const durations = new Set<number>();
    let curved = 0;
    for (let i = 0; i < 500; i += 1) {
        const swipe = humanSwipe({ x: 187, y: 550 }, { x: 187, y: 150 }, 450, {}, random);
        assert.ok(Math.abs(swipe.start.x - 187) <= 18 && Math.abs(swipe.start.y - 550) <= 12);
        assert.ok(Math.abs(swipe.end.x - 187) <= 30 && Math.abs(swipe.end.y - 150) <= 25);
        assert.ok(swipe.durationMs >= 360 && swipe.durationMs <= 540);
        durations.add(swipe.durationMs);

        const path = moves(swipe.actions);
        assert.deepEqual({ x: path[0].x, y: path[0].y }, swipe.start);
        assert.deepEqual({ x: path.at(-1)!.x, y: path.at(-1)!.y }, swipe.end);
        assert.ok(path.length >= 7 && path.length <= 11);
        // Segment durations add up to the swipe duration.
        assert.equal(path.slice(1).reduce((sum, move) => sum + move.duration, 0), swipe.durationMs);
        // Always moving upward, never doubling back.
        for (let j = 1; j < path.length; j += 1) assert.ok(path[j].y <= path[j - 1].y);
        // Finger is still moving fast when it lifts (flick, not a stop).
        const last = path.at(-1)!;
        const prev = path.at(-2)!;
        const avgSpeed = (swipe.start.y - swipe.end.y) / swipe.durationMs;
        assert.ok((prev.y - last.y) / last.duration > avgSpeed * 0.6);

        const xs = path.map((move) => move.x);
        const straightX = (y: number) => swipe.start.x + (swipe.end.x - swipe.start.x) * (y - swipe.start.y) / (swipe.end.y - swipe.start.y);
        if (path.some((move) => Math.abs(move.x - straightX(move.y)) >= 5)) curved += 1;
        assert.ok(xs.every((x) => Number.isInteger(x)));
    }
    assert.ok(durations.size > 50);
    assert.ok(curved > 100, `curved ${curved}`);
});

test('pathFromActions tracks the finger from touch-down to lift-off', () => {
    const path = pathFromActions([
        { type: 'pointerMove', duration: 0, x: 10, y: 100 },
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: 80 },
        { type: 'pointerMove', duration: 50, x: 12, y: 60 },
        { type: 'pointerMove', duration: 40, x: 15, y: 20 },
        { type: 'pointerUp', button: 0 },
    ]);
    assert.deepEqual(path, [
        { x: 10, y: 100, t: 0 }, { x: 10, y: 100, t: 80 }, { x: 12, y: 60, t: 130 }, { x: 15, y: 20, t: 170 },
    ]);
});

const screen = { width: 375, height: 667 };

test('planTouchGesture keeps calibration/plugin input exact', () => {
    const tap = planTouchGesture({ type: 'tap', x: 100, y: 200 }, screen, seeded(4));
    assert.deepEqual(tap.actions, [
        { type: 'pointerMove', duration: 0, x: 100, y: 200 },
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: 80 },
        { type: 'pointerUp', button: 0 },
    ]);
    const swipe = planTouchGesture({ type: 'swipe', startX: 187, startY: 500, endX: 187, endY: 150, durationMs: 300 }, screen, seeded(4));
    assert.equal(moves(swipe.actions).length, 2);
    assert.deepEqual(swipe.touch, {
        type: 'swipe', startX: 187, startY: 500, endX: 187, endY: 150, durationMs: 300,
        path: [{ x: 187, y: 500, t: 0 }, { x: 187, y: 500, t: 100 }, { x: 187, y: 150, t: 400 }],
    });
});

test('planTouchGesture humanizes dashboard taps without moving them', () => {
    const random = seeded(5);
    const holds = new Set<number>();
    for (let i = 0; i < 200; i += 1) {
        const { actions, touch } = planTouchGesture({ type: 'tap', x: 100, y: 200, humanize: true }, screen, random);
        assert.deepEqual(touch, { type: 'tap', x: 100, y: 200 });
        assert.deepEqual(moves(actions)[0], { type: 'pointerMove', duration: 0, x: 100, y: 200 });
        holds.add(actions.reduce((sum, a) => sum + ('duration' in a ? a.duration : 0), 0));
    }
    assert.ok(holds.size > 20);
});

test("planTouchGesture 'path' keeps endpoints and duration, 'full' varies them", () => {
    const random = seeded(6);
    const base = { type: 'swipe' as const, startX: 187, startY: 500, endX: 187, endY: 150, durationMs: 300 };
    let fullMoved = 0;
    for (let i = 0; i < 200; i += 1) {
        const path = planTouchGesture({ ...base, humanize: 'path' }, screen, random).touch;
        assert.equal(path.type, 'swipe');
        if (path.type !== 'swipe') return;
        assert.deepEqual([path.startX, path.startY, path.endX, path.endY, path.durationMs], [187, 500, 187, 150, 300]);
        assert.ok(path.path!.length >= 8);

        const full = planTouchGesture({ ...base, humanize: 'full' }, screen, random).touch;
        if (full.type !== 'swipe') return;
        if (full.startX !== 187 || full.endY !== 150 || full.durationMs !== 300) fullMoved += 1;
    }
    assert.ok(fullMoved > 150);
});

test('planTouchGesture never sends points off screen', () => {
    const random = seeded(7);
    for (let i = 0; i < 200; i += 1) {
        const { actions } = planTouchGesture(
            { type: 'swipe', startX: 0, startY: 667, endX: 375, endY: 0, durationMs: 300, humanize: 'full' }, screen, random);
        for (const move of moves(actions)) {
            assert.ok(move.x >= 0 && move.x <= 375 && move.y >= 0 && move.y <= 667);
        }
    }
});
