import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { remote, type Browser } from 'webdriverio';

import { loadRegisteredDevices, resolveDeviceCoordinates, WdaRemoteControl } from '@git-agni/phone-farm-core';
import { coordinateProfile } from '../tiktok/runtime-settings.js';
import { performSwipe, swipeCoordinates, tapCoordinate } from '../tiktok/actions.js';
import { profileSwipe, resolveSwipeStyle } from '../devices/swipe-profiles.js';
import {
    PROFILES,
    clampToDeadline,
    decideLike,
    decideLinger,
    hasTimeRemaining,
    isPersonality,
    pickWatchDurationMs,
} from '../tiktok/doomscroll-profile.js';
import { ReelWatchTracker } from '../facebook/reels-progress.js';
import { readReelScreenshot, reelsTabPoint, type ReelScreen } from './reels-screen.js';

function positiveInteger(name: string, fallback: number): number {
    const rawValue = process.env[name] ?? String(fallback);
    const value = Number.parseInt(rawValue, 10);
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer; received ${rawValue}`);
    }
    return value;
}

function percentEnv(name: string, fallback: number): number {
    const rawValue = process.env[name] ?? String(fallback);
    const value = Number(rawValue);
    if (!Number.isInteger(value) || value < 0 || value > 100) {
        throw new Error(`${name} must be an integer from 0 to 100; received ${rawValue}`);
    }
    return value;
}

function booleanEnv(name: string, fallback: boolean): boolean {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new Error(`${name} must be 'true' or 'false'; received ${raw}`);
}

const udid = process.env.IOS_UDID;
if (!udid) throw new Error('IOS_UDID is required.');

const personalityRaw = process.env.DOOMSCROLL_PERSONALITY ?? 'casual';
if (!isPersonality(personalityRaw)) {
    throw new Error(`DOOMSCROLL_PERSONALITY must be one of skimmer, casual, engaged; received ${personalityRaw}`);
}
const personality = personalityRaw;
const profile = PROFILES[personality];
const durationMinutes = positiveInteger('DOOMSCROLL_DURATION_MINUTES', 5);
if (durationMinutes > 180) throw new Error('DOOMSCROLL_DURATION_MINUTES must be at most 180');
const likeEnabled = booleanEnv('DOOMSCROLL_LIKE_ENABLED', true);
// Share of Reels (ads excluded) watched to the end instead of for the
// profile's usual watch time.
const fullWatchPercent = percentEnv('DOOMSCROLL_FULL_WATCH_PERCENT', 20);
const instagramBundleId = process.env.INSTAGRAM_BUNDLE_ID ?? 'com.burbn.instagram';
const wdaUrl = process.env.WDA_URL;

// Only the passcode keypad comes from the coordinate profile: everything on
// Instagram is read off screenshots (reels-screen.ts), and the swipe is
// scaled to the screen.
const registeredDevice = (await loadRegisteredDevices()).find((device) => device.udid === udid);
const coordinates = resolveDeviceCoordinates(coordinateProfile(registeredDevice), registeredDevice?.coordinates);
// Thumb-side swipe style (default right-thumb); undefined means the fixed swipe.
const swipeStyle = resolveSwipeStyle(undefined, coordinateProfile(registeredDevice));

// Cards between Reels (account suggestions, surveys, Threads posts) are fine
// now and then. Many screens in a row without a Reel or an ad means we left
// Reels — a pop-up, another screen, another app — so stop instead of
// swiping blindly.
const MAX_SCREENS_WITHOUT_REEL = 6;

// Watching a Reel to the end: the progress label is read every 1–1.8 s until
// the video loops back to its start (or Instagram moves on by itself). A Reel
// without progress can't be followed, so it gets the usual watch time
// instead; a very long one is left after this cap.
const MAX_FULL_WATCH_MS = 3 * 60_000;
const FULL_WATCH_PROGRESS_ATTEMPTS = 3;
const MAX_LOST_PROGRESS_READS = 8;
/** Instagram moved to the next Reel by itself: counts as watched when it had got this far. */
const AUTO_ADVANCE_COMPLETE = 0.85;
const progressPollMs = () => Math.round(1000 + Math.random() * 800);

const capabilities: WebdriverIO.Capabilities & Record<string, unknown> = {
    platformName: 'iOS',
    'appium:automationName': 'XCUITest',
    'appium:udid': udid,
    'appium:bundleId': instagramBundleId,
    'appium:noReset': true,
    'appium:forceAppLaunch': true,
    'appium:shouldTerminateApp': true,
    'appium:newCommandTimeout': 120,
    'appium:wdaLaunchTimeout': 120000,
    'appium:wdaConnectionTimeout': 120000,
    // Reels autoplay video, so the app never becomes idle.
    'appium:waitForIdleTimeout': 0,
    'appium:showXcodeLog': process.env.SHOW_XCODE_LOG === 'true',
};
if (wdaUrl) {
    capabilities['appium:webDriverAgentUrl'] = wdaUrl;
    capabilities['appium:wdaRemotePort'] = positiveInteger('WDA_REMOTE_PORT', 8100);
} else if (process.env.XCODE_ORG_ID) {
    capabilities['appium:xcodeOrgId'] = process.env.XCODE_ORG_ID;
    capabilities['appium:xcodeSigningId'] = process.env.XCODE_SIGNING_ID ?? 'Apple Development';
}
if (!wdaUrl && process.env.WDA_BUNDLE_ID) capabilities['appium:updatedWDABundleId'] = process.env.WDA_BUNDLE_ID;

// Cooperative cancellation: Stop sends SIGTERM; every wait races against it.
let stopRequested = false;
let resolveStop: () => void = () => {};
const stopPromise = new Promise<void>((resolve) => { resolveStop = resolve; });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => { stopRequested = true; resolveStop(); });
}

function cancellableDelay(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        void stopPromise.then(() => { clearTimeout(timer); resolve(); });
    });
}

const interactionPauseMs = () => Math.round(200 + Math.random() * 400);
// First look at a new screen: long enough for its labels to load and to
// look like a person noticing what it is.
const glanceMs = () => Math.round(700 + Math.random() * 800);
// Ads and cards are left quickly, but not instantly.
const adLookMs = () => Math.round(800 + Math.random() * 1700);
const cardLookMs = () => Math.round(1000 + Math.random() * 1500);

let driver: Browser | undefined;
let reelsViewed = 0;
let swipes = 0;
let likes = 0;
let likesConfirmed = 0;
let alreadyLiked = 0;
let adsSkipped = 0;
let cardsSkipped = 0;
let screensWithoutReel = 0;
let likeSkippedReelChanged = 0;
let autoAdvances = 0;
let fullWatchChosen = 0;
let fullWatchCompleted = 0;
let fullWatchNoProgress = 0;
let fullWatchAbandoned = 0;
const completedDurationsMs: number[] = [];
const runStartedAt = Date.now();

console.log(`Starting Instagram Reels doomscroll: profile=${personality} requestedDurationMinutes=${durationMinutes} likeEnabled=${likeEnabled} fullWatchPercent=${fullWatchPercent}`);

try {
    const remoteControl = new WdaRemoteControl({ deviceUdid: udid, wdaUrl, passcodeKeypadLayout: coordinates.passcodeKeypad });
    console.log('Checking device lock state');
    await remoteControl.unlock(udid);

    console.log(`Opening Instagram on ${udid}`);
    driver = await remote({
        hostname: process.env.APPIUM_HOST ?? '127.0.0.1',
        port: positiveInteger('APPIUM_PORT', 4725),
        path: '/',
        logLevel: 'warn',
        connectionRetryCount: 0,
        connectionRetryTimeout: 180000,
        capabilities,
    });
    await driver.updateSettings({ defaultActiveApplication: instagramBundleId });
    await driver.pause(4000);
    const window = await driver.getWindowRect();
    const { scale } = await remoteControl.getScreenInfo(udid);

    // Debug mode (DOOMSCROLL_DEBUG_DIR=<folder>): saves every screenshot the
    // script reads, with what was read off it, plus a screenshot after each
    // like and swipe.
    const debugDir = process.env.DOOMSCROLL_DEBUG_DIR ? path.resolve(process.env.DOOMSCROLL_DEBUG_DIR) : undefined;
    let debugSequence = 0;
    const debugShot = async (label: string, read?: { screenshot: Buffer; screen: ReelScreen }, settleMs = 0): Promise<void> => {
        if (!debugDir) return;
        try {
            if (settleMs) await driver!.pause(settleMs);
            await mkdir(debugDir, { recursive: true });
            debugSequence += 1;
            const base = path.join(debugDir, `${String(debugSequence).padStart(3, '0')}-reel${reelsViewed}-${label}`);
            await writeFile(`${base}.png`, read?.screenshot ?? await remoteControl.getScreenshot(udid));
            if (read) await writeFile(`${base}.json`, JSON.stringify(read.screen));
            console.log(`[debug] screenshot ${base}.png`);
        } catch (error) {
            console.log(`[debug] screenshot failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    };

    /** Undefined when the screen couldn't be read: never tap on that. */
    const readScreen = async (label: string): Promise<ReelScreen | undefined> => {
        try {
            const screenshot = await remoteControl.getScreenshot(udid);
            const screen = await readReelScreenshot(screenshot, scale);
            await debugShot(label, { screenshot, screen });
            return screen;
        } catch (error) {
            console.log(`Reading the screen failed: ${error instanceof Error ? error.message : String(error)}`);
            return undefined;
        }
    };

    type FullWatchOutcome = 'completed' | 'no-progress' | 'abandoned' | 'out-of-time';
    // Set when Instagram moved to the next Reel by itself (end of the video,
    // or after its "Intéressé(e)" prompt): the new Reel is then watched as
    // the next one instead of being swiped past unseen.
    let advancedOnItsOwn = false;

    // Follows the progress label until the video loops back to its start.
    const watchToEnd = async (reelId: string | undefined): Promise<FullWatchOutcome> => {
        const tracker = new ReelWatchTracker();
        const startedAt = Date.now();
        let reads = 0;
        let lostReads = 0;
        let sampled = false;
        let lastProgress = 0;
        while (timeLeft()) {
            if (Date.now() - startedAt > MAX_FULL_WATCH_MS) {
                console.log(`Still not at the end after ${Math.round(MAX_FULL_WATCH_MS / 1000)} s; moving on`);
                return 'abandoned';
            }
            const screen = await readScreen('progress');
            reads += 1;
            if (screen && reelId && screen.reelId && screen.reelId !== reelId) {
                advancedOnItsOwn = true;
                if (lastProgress >= AUTO_ADVANCE_COMPLETE) {
                    const durationMs = tracker.estimateDurationMs();
                    if (durationMs) completedDurationsMs.push(durationMs);
                    console.log(`Instagram moved to the next Reel after ${Math.round(lastProgress * 100)}%: watched to the end`);
                    return 'completed';
                }
                console.log('The Reel changed before its end; moving on');
                return 'abandoned';
            }
            const progress = screen?.progress;
            if (progress === undefined) {
                lostReads += 1;
                if (!sampled && reads >= FULL_WATCH_PROGRESS_ATTEMPTS) return 'no-progress';
                if (sampled && lostReads >= MAX_LOST_PROGRESS_READS) {
                    console.log('Lost the video progress; moving on');
                    return 'abandoned';
                }
            } else {
                sampled = true;
                lostReads = 0;
                lastProgress = progress;
                const state = tracker.add({ atMs: Date.now(), progress });
                if (state.kind === 'completed') {
                    const watchedS = ((Date.now() - startedAt) / 1000).toFixed(1);
                    if (state.durationMs) completedDurationsMs.push(state.durationMs);
                    const length = state.durationMs ? `${(state.durationMs / 1000).toFixed(1)} s` : 'unknown';
                    console.log(`Watched to the end: video length ≈ ${length}, followed for ${watchedS} s`);
                    return 'completed';
                }
            }
            await cancellableDelay(clampToDeadline(Date.now(), deadline, progressPollMs()));
        }
        return 'out-of-time';
    };

    // Upward swipe on the video itself: starts above the caption, the
    // account row and the ad call-to-action strip, left of the button column.
    const swipeToNext = async (): Promise<void> => {
        const x = Math.round(window.width * 0.5);
        const startY = Math.round(window.height * 0.62);
        const endY = Math.round(window.height * 0.21);
        const swipe = swipeStyle
            ? await performSwipe(driver!, profileSwipe(swipeStyle))
            : await swipeCoordinates(driver!, { x, y: startY }, { x, y: endY }, 380);
        swipes += 1;
        console.log(`Swiped (${swipe.start.x}, ${swipe.start.y}) -> (${swipe.end.x}, ${swipe.end.y}) in ${swipe.durationMs} ms`);
    };

    // A cold launch opens the home feed; Reels is a tab away.
    const reelsTab = reelsTabPoint(window);
    await tapCoordinate(driver, reelsTab.x, reelsTab.y, 'Reels tab', { radius: 6 });
    await driver.pause(3000);
    // Confirm we really are on Reels before scrolling. The first screen can
    // be a card, so allow a couple of swipes to find a Reel.
    let arrival = await readScreen('arrival');
    for (let attempt = 0; arrival?.kind !== 'reel' && arrival?.kind !== 'ad' && attempt < 3 && !stopRequested; attempt++) {
        if (!arrival?.onReels) break;
        await swipeToNext();
        await driver.pause(2500);
        arrival = await readScreen(`arrival-retry${attempt + 1}`);
    }
    if (!stopRequested && (!arrival?.onReels || arrival.kind === 'other')) {
        throw new Error('Could not confirm the Instagram Reels screen (no Reel with a J’aime button found); stopping without scrolling');
    }
    console.log('On Instagram Reels');

    const deadline = Date.now() + durationMinutes * 60_000;
    const timeLeft = () => !stopRequested && hasTimeRemaining(Date.now(), deadline);

    while (timeLeft()) {
        advancedOnItsOwn = false;
        const reelStartedAt = Date.now();
        const watchMs = pickWatchDurationMs(profile);
        await cancellableDelay(clampToDeadline(Date.now(), deadline, Math.min(glanceMs(), watchMs)));
        if (!timeLeft()) break;
        const first = await readScreen('glance');

        if (first?.kind !== 'reel') {
            if (first?.kind === 'ad') {
                adsSkipped += 1;
                screensWithoutReel = 0;
                console.log(`Ad (${first.reelId ?? 'sponsored'}); skipping`);
                await cancellableDelay(clampToDeadline(Date.now(), deadline, adLookMs()));
            } else {
                screensWithoutReel += 1;
                if (first?.onReels) cardsSkipped += 1;
                const what = !first ? 'Unreadable screen' : first.onReels ? 'Not a Reel (card)' : 'Not on the Reels tab';
                console.log(`${what} (${screensWithoutReel} in a row); skipping`);
                if (screensWithoutReel >= MAX_SCREENS_WITHOUT_REEL) {
                    throw new Error(`No Reel on ${screensWithoutReel} screens in a row; Instagram is probably showing another screen. Stopping.`);
                }
                await cancellableDelay(clampToDeadline(Date.now(), deadline, cardLookMs()));
            }
            if (!timeLeft()) break;
            await swipeToNext();
            await debugShot('after-skip', undefined, 1000);
            continue;
        }
        screensWithoutReel = 0;

        let fullyWatched = false;
        if (fullWatchPercent > 0 && Math.random() * 100 < fullWatchPercent) {
            fullWatchChosen += 1;
            console.log(`Watching this Reel to the end (${first.reelId ?? 'unnamed'})`);
            const outcome = await watchToEnd(first.reelId);
            if (outcome === 'completed') {
                fullWatchCompleted += 1;
                fullyWatched = true;
            } else if (outcome === 'no-progress') {
                fullWatchNoProgress += 1;
                console.log('No video progress on this Reel; watching it the usual time instead');
            } else if (outcome === 'abandoned') {
                fullWatchAbandoned += 1;
                fullyWatched = true;
            }
        }
        if (!fullyWatched) {
            await cancellableDelay(clampToDeadline(Date.now(), deadline, watchMs - (Date.now() - reelStartedAt)));
        }
        reelsViewed += 1;
        if (!timeLeft()) break;

        if (likeEnabled && decideLike(profile)) {
            // Read again right before the tap: Instagram can move to the next
            // Reel on its own, and J'aime moves with the caption length.
            const current = await readScreen('before-like');
            if (!current || current.kind !== 'reel' || !current.like) {
                console.log('J’aime not found on screen any more; not liking');
            } else if (first.reelId && current.reelId !== first.reelId) {
                likeSkippedReelChanged += 1;
                advancedOnItsOwn = true;
                console.log('Instagram moved to another Reel since this one was watched; not liking');
            } else if (current.like.liked) {
                // J'aime is a toggle: tapping again would remove the like.
                alreadyLiked += 1;
                console.log('Reel already liked; skipping the tap');
            } else {
                await cancellableDelay(clampToDeadline(Date.now(), deadline, interactionPauseMs()));
                if (!timeLeft()) break;
                // The button is 45×44 pt; keep the tap well inside it.
                await tapCoordinate(driver, current.like.x, current.like.y, 'J’aime', { radius: 6 });
                likes += 1;
                await driver.pause(700);
                const after = await readScreen('after-like');
                if (after?.like?.liked) {
                    likesConfirmed += 1;
                    console.log('Like confirmed (J’aime shown as pressed)');
                } else {
                    console.log('Like not confirmed on screen (J’aime not shown as pressed)');
                }
            }
        }
        if (!timeLeft()) break;

        if (advancedOnItsOwn) {
            autoAdvances += 1;
            console.log('Already on the next Reel; watching it without swiping');
            continue;
        }

        // A Reel watched to the end is left soon after it starts over.
        const { linger, extraMs } = fullyWatched ? { linger: false, extraMs: 0 } : decideLinger(profile);
        if (linger) await cancellableDelay(clampToDeadline(Date.now(), deadline, extraMs));
        if (!timeLeft()) break;
        await cancellableDelay(clampToDeadline(Date.now(), deadline, interactionPauseMs()));
        if (!timeLeft()) break;

        await swipeToNext();
        await debugShot('after-swipe', undefined, 1000);
    }

    const reason = stopRequested ? 'stopped' : 'completed';
    const completionRate = reelsViewed ? (100 * fullWatchCompleted / reelsViewed).toFixed(1) : '0.0';
    const averageLength = completedDurationsMs.length
        ? `${(completedDurationsMs.reduce((sum, value) => sum + value, 0) / completedDurationsMs.length / 1000).toFixed(1)}s`
        : 'n/a';
    const lengths = completedDurationsMs.map((value) => `${(value / 1000).toFixed(1)}s`).join(',') || 'none';
    console.log(`Full watches: target=${fullWatchPercent}% chosen=${fullWatchChosen} completed=${fullWatchCompleted} noProgress=${fullWatchNoProgress} abandoned=${fullWatchAbandoned} completionRate=${completionRate}% averageVideoLength=${averageLength} videoLengths=${lengths}`);
    console.log(`Finished Instagram Reels doomscroll: reelsViewed=${reelsViewed} swipes=${swipes} likes=${likes} likesConfirmed=${likesConfirmed} alreadyLiked=${alreadyLiked} likeSkippedReelChanged=${likeSkippedReelChanged} adsSkipped=${adsSkipped} cardsSkipped=${cardsSkipped} autoAdvances=${autoAdvances} elapsedMs=${Date.now() - runStartedAt} reason=${reason}`);
} finally {
    if (driver) await driver.deleteSession();
}
