// Human-like variation for taps and swipes. A bot that hits the exact same
// pixel with the exact same press length, and swipes a perfectly straight
// line at a perfectly constant speed every time, is easy to fingerprint.
// Everything here is pure (randomness is injectable) so it can be tested;
// automation (src/tiktok/actions.ts) and the dashboard remote control
// (wda-remote.ts) both build their gestures from it.

export type Random = () => number;

export interface Point { x: number; y: number }

/** One W3C pointer action, as accepted by webdriverio's performActions. */
export type PointerAction =
    | { type: 'pointerMove'; duration: number; x: number; y: number }
    | { type: 'pointerDown'; button: 0 }
    | { type: 'pointerUp'; button: 0 }
    | { type: 'pause'; duration: number };

function uniform(min: number, max: number, random: Random): number {
    return min + random() * (max - min);
}

/** Standard normal sample (Box–Muller). */
function gaussian(random: Random): number {
    const u = Math.max(random(), Number.EPSILON);
    const v = random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

/**
 * Offset a point by a normally distributed amount, most taps landing near
 * the centre and none further than `radius` points away.
 */
export function jitterPoint(point: Point, radius: number, random: Random = Math.random): Point {
    if (radius <= 0) return { x: Math.round(point.x), y: Math.round(point.y) };
    const sigma = radius / 2;
    return {
        x: Math.round(point.x + clamp(gaussian(random) * sigma, -radius, radius)),
        y: Math.round(point.y + clamp(gaussian(random) * sigma, -radius, radius)),
    };
}

export interface TapOptions {
    /** Max distance (points) from the target. Keep it below half the button size. */
    radius?: number;
}

export interface HumanTap {
    point: Point;
    actions: PointerAction[];
}

/**
 * A tap that lands slightly off-target, is held for a variable time, and
 * sometimes rolls a point or two while the finger is down (like a real
 * fingertip does).
 */
export function humanTap(target: Point, options: TapOptions = {}, random: Random = Math.random): HumanTap {
    const point = jitterPoint(target, options.radius ?? 4, random);
    const holdMs = Math.round(clamp(95 + gaussian(random) * 25, 55, 170));
    const actions: PointerAction[] = [
        { type: 'pointerMove', duration: 0, x: point.x, y: point.y },
        { type: 'pointerDown', button: 0 },
    ];
    if (random() < 0.35) {
        // Small roll while pressed: split the hold around a 1–2 pt move.
        const firstPart = Math.round(holdMs * uniform(0.3, 0.7, random));
        const roll = {
            x: point.x + Math.round(uniform(-2, 2, random)),
            y: point.y + Math.round(uniform(-2, 2, random)),
        };
        actions.push(
            { type: 'pause', duration: firstPart },
            { type: 'pointerMove', duration: holdMs - firstPart, x: roll.x, y: roll.y },
        );
    } else {
        actions.push({ type: 'pause', duration: holdMs });
    }
    actions.push({ type: 'pointerUp', button: 0 });
    return { point, actions };
}

export interface SwipeOptions {
    /** Max offset (points) applied to the start point. */
    startRadius?: Point;
    /** Max offset (points) applied to the end point. */
    endRadius?: Point;
    /** Duration varies by ± this fraction (0.2 = ±20%). */
    durationJitter?: number;
    /** Max sideways bow of the path, as a fraction of its length. */
    maxCurve?: number;
}

export interface HumanSwipe {
    start: Point;
    end: Point;
    durationMs: number;
    actions: PointerAction[];
}

// Velocity of the swipe follows the rising part of a bell curve and the
// finger lifts while still moving (~70% of peak speed), the way a real flick
// does — never a constant-speed glide, and never slowing to a stop (which
// TikTok could read as a drag-and-release instead of a page flick).
const LIFT_PHASE = 0.75;
function swipeProgress(t: number): number {
    const ease = (u: number) => (1 - Math.cos(Math.PI * u)) / 2;
    return ease(t * LIFT_PHASE) / ease(LIFT_PHASE);
}

function quadraticBezier(a: Point, control: Point, b: Point, t: number): Point {
    const mt = 1 - t;
    return {
        x: mt * mt * a.x + 2 * mt * t * control.x + t * t * b.x,
        y: mt * mt * a.y + 2 * mt * t * control.y + t * t * b.y,
    };
}

/**
 * A swipe whose start, end, duration, path curvature and speed profile all
 * vary between calls. The path is a gentle arc (thumbs swing, they don't
 * slide on rails) split into several timed segments.
 */
export function humanSwipe(
    from: Point,
    to: Point,
    durationMs: number,
    options: SwipeOptions = {},
    random: Random = Math.random,
): HumanSwipe {
    const startRadius = options.startRadius ?? { x: 18, y: 12 };
    const endRadius = options.endRadius ?? { x: 30, y: 25 };
    const durationJitter = options.durationJitter ?? 0.2;
    const maxCurve = options.maxCurve ?? 0.08;

    const offset = (radius: Point): Point => ({
        x: clamp(gaussian(random) * radius.x / 2, -radius.x, radius.x),
        y: clamp(gaussian(random) * radius.y / 2, -radius.y, radius.y),
    });
    const startOffset = offset(startRadius);
    const endOffset = offset(endRadius);
    const start = { x: Math.round(from.x + startOffset.x), y: Math.round(from.y + startOffset.y) };
    const end = { x: Math.round(to.x + endOffset.x), y: Math.round(to.y + endOffset.y) };
    const totalMs = Math.max(120, Math.round(durationMs * (1 + uniform(-durationJitter, durationJitter, random))));

    // Bow the path sideways around a control point near the middle.
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy) || 1;
    const bow = uniform(-maxCurve, maxCurve, random) * length;
    const along = uniform(0.35, 0.65, random);
    const control = {
        x: start.x + dx * along + (-dy / length) * bow,
        y: start.y + dy * along + (dx / length) * bow,
    };

    const segments = 6 + Math.floor(random() * 5); // 6–10
    const touchDownMs = Math.round(clamp(80 + gaussian(random) * 30, 30, 160));
    const actions: PointerAction[] = [
        { type: 'pointerMove', duration: 0, x: start.x, y: start.y },
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: touchDownMs },
    ];
    let elapsed = 0;
    for (let i = 1; i <= segments; i += 1) {
        const t = i / segments;
        const segmentEnd = Math.round(totalMs * t);
        const point = i === segments ? end : quadraticBezier(start, control, end, swipeProgress(t));
        actions.push({ type: 'pointerMove', duration: segmentEnd - elapsed, x: Math.round(point.x), y: Math.round(point.y) });
        elapsed = segmentEnd;
    }
    actions.push({ type: 'pointerUp', button: 0 });
    return { start, end, durationMs: totalMs, actions };
}

/** A point along a gesture, `t` ms after the finger touched down. */
export interface TimedPoint { x: number; y: number; t: number }

/**
 * Where the finger is over time, for drawing the real trajectory on the live
 * screen overlay. Starts at touch-down (t = 0) and ends at lift-off.
 */
export function pathFromActions(actions: readonly PointerAction[]): TimedPoint[] {
    const path: TimedPoint[] = [];
    let current: Point = { x: 0, y: 0 };
    let down = false;
    let t = 0;
    for (const action of actions) {
        if (action.type === 'pointerMove') {
            current = { x: action.x, y: action.y };
            if (down) {
                t += action.duration;
                path.push({ ...current, t });
            }
        } else if (action.type === 'pointerDown') {
            down = true;
            path.push({ ...current, t });
        } else if (action.type === 'pause') {
            if (down && action.duration > 0) {
                t += action.duration;
                path.push({ ...current, t });
            }
        } else if (down) {
            break;
        }
    }
    return path;
}
