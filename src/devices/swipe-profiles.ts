import { humanSwipe, type HumanSwipe, type Random } from './humanize.js';
import { SWIPE_PROFILE_DATA, SWIPE_PROFILE_RULES } from './swipe-profile-data.js';

// Swipe styles learned from real recordings (trainer-app). Each profile is a
// thumb side: which finger swipes decides where on the screen the swipe
// happens and which way it curves.
//
// Rules: every value a profile produces stays inside the range its recordings
// showed, and the curve keeps the profile's side. Within those rules each
// swipe is randomized a little, so no two swipes are the same.

export type SwipeProfile = keyof typeof SWIPE_PROFILE_DATA;
export const SWIPE_PROFILES = Object.keys(SWIPE_PROFILE_DATA) as SwipeProfile[];

/** Move `value` by up to `spread` of the rule range, then keep it inside the range. */
function wiggle(value: number, [lo, hi]: readonly [number, number], random: Random, spread = 0.1): number {
    const moved = value + (random() * 2 - 1) * spread * (hi - lo);
    return Math.min(hi, Math.max(lo, moved));
}

/**
 * One upward swipe in the style of `profile`. A real donor swipe supplies the
 * starting point, so the thumb side sets the screen position; the other values
 * are randomized within the profile's rules. `minTravel` (points) rescales the
 * profile's travel range to start there, for apps that ignore short flicks;
 * the spread of lengths is kept.
 */
export function profileSwipe(profile: SwipeProfile, random: Random = Math.random, minTravel?: number): HumanSwipe {
    const rows = SWIPE_PROFILE_DATA[profile];
    const rules = SWIPE_PROFILE_RULES[profile];
    if (!rows || rows.length === 0 || !rules) throw new Error(`No swipe data for profile "${profile}"`);
    const donor = rows[Math.floor(random() * rows.length)];
    const r = rules.ranges;

    const from = { x: wiggle(donor.startX, r.startX, random, 0.05), y: wiggle(donor.startY, r.startY, random, 0.05) };
    const [travelLo, travelHi] = r.travel;
    let travel = wiggle(donor.travel, r.travel, random);
    if (minTravel !== undefined && minTravel > travelLo && minTravel < travelHi) {
        travel = minTravel + ((travel - travelLo) / (travelHi - travelLo)) * (travelHi - minTravel);
    }
    const endX = wiggle(donor.endX, r.endX, random, 0.05);
    const to = { x: endX, y: from.y - travel };

    // The curve always bends the profile's way; only its size varies.
    const bowSize = wiggle(Math.abs(donor.bow), rules.bowMagnitude, random, 0.15);
    return humanSwipe(from, to, wiggle(donor.duration, r.duration, random), {
        durationJitter: 0,
        bow: rules.bowSign * bowSize,
        touchDownMs: wiggle(donor.touchDown, r.touchDown, random, 0.15),
        startRadius: { x: 0, y: 0 },
        endRadius: { x: 0, y: 0 },
    }, random);
}

/** The phone the swipe profiles were recorded on. Their coordinates are points on this screen. */
export const SWIPE_STYLE_COORDINATE_PROFILE = 'iphonexr';

/** Used when a run does not ask for a style. */
export const DEFAULT_SWIPE_STYLE: SwipeProfile = 'right-thumb';

/** Every style a caller may ask for. 'fixed' is the old fixed-coordinate swipe. */
export const SWIPE_STYLES = ['right-thumb', 'left-thumb', 'left-index', 'right-index', 'fixed'] as const;
export type SwipeStyle = (typeof SWIPE_STYLES)[number];

/**
 * The style a run uses. Nothing requested means the default, which on phones
 * without recordings quietly falls back to the fixed swipe. Asking for a
 * recorded style on such a phone is an error.
 */
export function resolveSwipeStyle(requested: SwipeStyle | undefined, coordinateProfileName: string): SwipeProfile | undefined {
    const style = requested ?? DEFAULT_SWIPE_STYLE;
    if (style === 'fixed') return undefined;
    if (coordinateProfileName !== SWIPE_STYLE_COORDINATE_PROFILE) {
        if (requested !== undefined) {
            throw new Error(`swipe style ${style} is only recorded for ${SWIPE_STYLE_COORDINATE_PROFILE} phones; this device uses ${coordinateProfileName}`);
        }
        return undefined;
    }
    return style;
}
