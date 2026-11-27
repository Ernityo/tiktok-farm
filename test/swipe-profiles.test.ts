import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SWIPE_STYLE, profileSwipe, resolveSwipeStyle, SWIPE_PROFILES, type SwipeProfile } from '../src/devices/swipe-profiles.js';
import type { PointerAction } from '../src/devices/humanize.js';
import { SWIPE_PROFILE_RULES } from '../src/devices/swipe-profile-data.js';

// Signed sideways bow of a swipe's path, as a fraction of its length (same measure as the builder).
function bowOf(actions: readonly PointerAction[]): number {
    const pts = actions.filter((a): a is Extract<PointerAction, { type: 'pointerMove' }> => a.type === 'pointerMove');
    const a = pts[0], b = pts[pts.length - 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    let best = 0;
    for (const p of pts) {
        const t = (p.y - a.y) / (dy || 1);
        const off = p.x - (a.x + t * dx);
        if (Math.abs(off) > Math.abs(best)) best = off;
    }
    return best / len;
}

function sample(profile: SwipeProfile, n: number) {
    let seed = 42;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    return Array.from({ length: n }, () => profileSwipe(profile, random));
}

test('every profile has real swipes behind it', () => {
    assert.deepEqual(SWIPE_PROFILES.sort(), ['left-index', 'left-thumb', 'right-index', 'right-thumb']);
});

test('thumb side sets the curve direction', () => {
    const sign = (profile: SwipeProfile) => sample(profile, 300).filter(s => bowOf(s.actions) < 0).length / 300;
    assert.ok(sign('right-thumb') > 0.9, 'right thumb should curve left');
    assert.ok(sign('right-index') > 0.9, 'right index should curve left');
    assert.ok(sign('left-thumb') < 0.1, 'left thumb should curve right');
});

test('swipes stay upward and close to the profile travel', () => {
    for (const s of sample('right-thumb', 200)) {
        assert.ok(s.end.y < s.start.y, 'swipe goes up');
        const travel = s.start.y - s.end.y;
        assert.ok(travel > 40 && travel < 300, `travel ${travel} pt is in the range of real swipes`);
        assert.ok(s.durationMs >= 60 && s.durationMs <= 300, `duration ${s.durationMs} ms is in the range of real swipes`);
    }
});

test('thumb side sets the screen side where the swipe happens', () => {
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const startX = (profile: SwipeProfile) => mean(sample(profile, 200).map(s => s.start.x));
    assert.ok(startX('right-thumb') > 207, 'right thumb works the right side');
    assert.ok(startX('left-thumb') < 207, 'left thumb works the left side');
    assert.ok(startX('left-index') < startX('right-index'), 'left index starts left of right index');
});

test('every swipe stays inside its profile rules and keeps the curve side', () => {
    for (const profile of SWIPE_PROFILES) {
        const rules = SWIPE_PROFILE_RULES[profile];
        const r = rules.ranges;
        const swipes = sample(profile, 300);
        for (const s of swipes) {
            const travel = s.start.y - s.end.y;
            const bow = bowOf(s.actions);
            assert.ok(s.start.x >= r.startX[0] - 1 && s.start.x <= r.startX[1] + 1, `${profile} start x ${s.start.x}`);
            assert.ok(s.start.y >= r.startY[0] - 1 && s.start.y <= r.startY[1] + 1, `${profile} start y ${s.start.y}`);
            assert.ok(s.end.x >= r.endX[0] - 1 && s.end.x <= r.endX[1] + 1, `${profile} end x ${s.end.x}`);
            assert.ok(travel >= r.travel[0] - 2 && travel <= r.travel[1] + 2, `${profile} travel ${travel}`);
            assert.ok(s.durationMs >= r.duration[0] - 1 && s.durationMs <= r.duration[1] + 1, `${profile} duration ${s.durationMs}`);
            assert.equal(Math.sign(bow), rules.bowSign, `${profile} curve side`);
        }
        const xs = new Set(swipes.map(s => s.start.x));
        assert.ok(xs.size > 20, `${profile} start points vary (${xs.size} distinct)`);
    }
});

test('the default style is right-thumb and needs no setting', () => {
    assert.equal(DEFAULT_SWIPE_STYLE, 'right-thumb');
    assert.equal(resolveSwipeStyle(undefined, 'iphonexr'), 'right-thumb');
    assert.equal(resolveSwipeStyle('left-thumb', 'iphonexr'), 'left-thumb');
    assert.equal(resolveSwipeStyle('fixed', 'iphonexr'), undefined);
});

test('phones without recordings fall back to the fixed swipe by default, but refuse an explicit style', () => {
    assert.equal(resolveSwipeStyle(undefined, 'iphone8'), undefined);
    assert.throws(() => resolveSwipeStyle('left-thumb', 'iphone8'), /only recorded for iphonexr/);
});

test('a minimum travel lifts short swipes but keeps their spread', () => {
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const hi = SWIPE_PROFILE_RULES['right-thumb'].ranges.travel[1];
    const travels = Array.from({ length: 300 }, () => {
        const s = profileSwipe('right-thumb', random, 110);
        return s.start.y - s.end.y;
    });
    for (const travel of travels) assert.ok(travel >= 109.5 && travel <= hi + 0.5, `travel ${travel} pt is between 110 and ${hi}`);
    const distinct = new Set(travels.map((t) => Math.round(t))).size;
    assert.ok(distinct > 50, `lengths stay varied (${distinct} distinct)`);
});
