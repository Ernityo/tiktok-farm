import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { remote, type Browser } from 'webdriverio';

import { loadRegisteredDevices, resolveDeviceCoordinates, WdaRemoteControl } from '@git-agni/phone-farm-core';
import { coordinateProfile } from '../tiktok/runtime-settings.js';
import { swipeCoordinates, tapCoordinate } from '../tiktok/actions.js';
import {
    PROFILES,
    clampToDeadline,
    decideLike,
    decideLinger,
    hasTimeRemaining,
    isPersonality,
    pickWatchDurationMs,
} from '../tiktok/doomscroll-profile.js';
import { detectReelsControls, detectTranslatedCaption, type ReelsControls } from './reels-controls.js';

function positiveInteger(name: string, fallback: number): number {
    const rawValue = process.env[name] ?? String(fallback);
    const value = Number.parseInt(rawValue, 10);
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer; received ${rawValue}`);
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
const facebookBundleId = process.env.FACEBOOK_BUNDLE_ID ?? 'com.facebook.Facebook';
const wdaUrl = process.env.WDA_URL;

const registeredDevice = (await loadRegisteredDevices()).find((device) => device.udid === udid);
const coordinates = resolveDeviceCoordinates(coordinateProfile(registeredDevice), registeredDevice?.coordinates);
const facebook = coordinates.facebook;
if (!facebook) {
    throw new Error(`Coordinate profile "${coordinateProfile(registeredDevice)}" has no Facebook layout yet; only measured devices (iPhone XR) are supported`);
}

// A Reel without the like/comment/share column is fine now and then
// (suggestion cards, a white video behind the icons). Many in a row means we
// are no longer on Reels — a pop-up, another screen, another app — so stop
// instead of swiping blindly.
const MAX_REELS_WITHOUT_RAIL = 6;

const capabilities: WebdriverIO.Capabilities & Record<string, unknown> = {
    platformName: 'iOS',
    'appium:automationName': 'XCUITest',
    'appium:udid': udid,
    'appium:bundleId': facebookBundleId,
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
// How long a Reel is looked at before deciding it isn't French: long enough
// for the caption to render and to look like a person reading it.
const glanceMs = () => Math.round(700 + Math.random() * 800);

let driver: Browser | undefined;
let reelsViewed = 0;
let swipes = 0;
let likes = 0;
let alreadyLiked = 0;
let reelsWithoutRail = 0;
let translatedSkipped = 0;
const runStartedAt = Date.now();

console.log(`Starting Facebook Reels doomscroll: profile=${personality} requestedDurationMinutes=${durationMinutes} likeEnabled=${likeEnabled}`);

try {
    const remoteControl = new WdaRemoteControl({ deviceUdid: udid, wdaUrl, passcodeKeypadLayout: coordinates.passcodeKeypad });
    console.log('Checking device lock state');
    await remoteControl.unlock(udid);

    console.log(`Opening Facebook on ${udid}`);
    driver = await remote({
        hostname: process.env.APPIUM_HOST ?? '127.0.0.1',
        port: positiveInteger('APPIUM_PORT', 4725),
        path: '/',
        logLevel: 'info',
        connectionRetryCount: 0,
        connectionRetryTimeout: 180000,
        capabilities,
    });
    await driver.updateSettings({ defaultActiveApplication: facebookBundleId });
    await driver.pause(4000);
    const { scale } = await remoteControl.getScreenInfo(udid);

    // Debug mode (DOOMSCROLL_DEBUG_DIR=<folder>): saves every screenshot the
    // script looks at, plus one after each like and swipe.
    const debugDir = process.env.DOOMSCROLL_DEBUG_DIR ? path.resolve(process.env.DOOMSCROLL_DEBUG_DIR) : undefined;
    let debugSequence = 0;
    const debugShot = async (label: string, screenshot?: Buffer, settleMs = 0): Promise<void> => {
        if (!debugDir) return;
        try {
            if (settleMs) await driver!.pause(settleMs);
            await mkdir(debugDir, { recursive: true });
            debugSequence += 1;
            const file = path.join(debugDir, `${String(debugSequence).padStart(3, '0')}-reel${reelsViewed}-${label}.png`);
            await writeFile(file, screenshot ?? await remoteControl.getScreenshot(udid));
            console.log(`[debug] screenshot ${file}`);
        } catch (error) {
            console.log(`[debug] screenshot failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    };

    const locateControls = async (label: string): Promise<ReelsControls | undefined> => {
        try {
            const screenshot = await remoteControl.getScreenshot(udid);
            await debugShot(label, screenshot);
            return await detectReelsControls(screenshot, scale);
        } catch (error) {
            console.log(`J'aime detection failed: ${error instanceof Error ? error.message : String(error)}`);
            return undefined;
        }
    };

    // "Afficher l'original" under the caption: Facebook translated it into
    // French, so the Reel isn't French content. Detection errors count as
    // French (keep watching) rather than skipping blindly.
    const isTranslated = async (): Promise<boolean> => {
        try {
            const screenshot = await remoteControl.getScreenshot(udid);
            await debugShot('caption', screenshot);
            const { translated, score } = await detectTranslatedCaption(screenshot, scale);
            if (translated) console.log(`Caption shows "Afficher l'original" (score ${score.toFixed(2)}): translated, not French`);
            return translated;
        } catch (error) {
            console.log(`Caption check failed: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    };

    const swipeToNext = async (): Promise<void> => {
        const { x, startY, endY, durationMs } = facebook.swipe;
        const swipe = await swipeCoordinates(driver!, { x, y: startY }, { x, y: endY }, durationMs);
        swipes += 1;
        console.log(`Swiped (${swipe.start.x}, ${swipe.start.y}) -> (${swipe.end.x}, ${swipe.end.y}) in ${swipe.durationMs} ms`);
    };

    // A cold launch opens the home feed; Reels is a tab away.
    await tapCoordinate(driver, facebook.reelsTab.x, facebook.reelsTab.y, 'Reels tab', { radius: 6 });
    await driver.pause(3000);
    // Confirm we really are on Reels before scrolling. The first Reel can be
    // a suggestion card, so allow a couple of swipes to find the rail.
    let onReels = Boolean(await locateControls('arrival'));
    for (let attempt = 0; !onReels && attempt < 3 && !stopRequested; attempt++) {
        await swipeToNext();
        await driver.pause(2500);
        onReels = Boolean(await locateControls(`arrival-retry${attempt + 1}`));
    }
    if (!onReels && !stopRequested) {
        throw new Error('Could not confirm the Facebook Reels screen (no like/comment/share column found); stopping without scrolling');
    }
    console.log('On Facebook Reels');

    const deadline = Date.now() + durationMinutes * 60_000;
    const timeLeft = () => !stopRequested && hasTimeRemaining(Date.now(), deadline);

    while (timeLeft()) {
        const reelStartedAt = Date.now();
        const watchMs = pickWatchDurationMs(profile);
        // Only French Reels get watched: glance at the caption and move on
        // quickly when Facebook translated it.
        await cancellableDelay(clampToDeadline(Date.now(), deadline, Math.min(glanceMs(), watchMs)));
        if (!timeLeft()) break;
        if (await isTranslated()) {
            translatedSkipped += 1;
            await cancellableDelay(clampToDeadline(Date.now(), deadline, interactionPauseMs()));
            if (!timeLeft()) break;
            await swipeToNext();
            await debugShot('after-skip', undefined, 1000);
            continue;
        }
        await cancellableDelay(clampToDeadline(Date.now(), deadline, watchMs - (Date.now() - reelStartedAt)));
        reelsViewed += 1;
        if (!timeLeft()) break;

        // Looked up right before any tap: Reels can auto-advance when a video
        // ends, so an older screenshot may belong to a different Reel.
        const controls = await locateControls('detect');
        if (controls) {
            reelsWithoutRail = 0;
        } else {
            reelsWithoutRail += 1;
            console.log(`No like/comment/share column on this Reel (${reelsWithoutRail} in a row); not liking`);
            if (reelsWithoutRail >= MAX_REELS_WITHOUT_RAIL) {
                throw new Error(`No Reels controls on ${reelsWithoutRail} Reels in a row; Facebook is probably showing another screen. Stopping.`);
            }
        }

        if (likeEnabled && controls && decideLike(profile)) {
            if (controls.liked) {
                // J'aime is a toggle: tapping again would remove the like.
                alreadyLiked += 1;
                console.log('Reel already liked; skipping the tap');
            } else {
                await cancellableDelay(clampToDeadline(Date.now(), deadline, interactionPauseMs()));
                if (!timeLeft()) break;
                // The disc is ~32 pt wide; keep the tap well inside it.
                await tapCoordinate(driver, controls.like.x, controls.like.y, "J'aime", { radius: 4 });
                likes += 1;
                await debugShot('after-like', undefined, 800);
            }
        }
        if (!timeLeft()) break;

        const { linger, extraMs } = decideLinger(profile);
        if (linger) await cancellableDelay(clampToDeadline(Date.now(), deadline, extraMs));
        if (!timeLeft()) break;
        await cancellableDelay(clampToDeadline(Date.now(), deadline, interactionPauseMs()));
        if (!timeLeft()) break;

        await swipeToNext();
        await debugShot('after-swipe', undefined, 1000);
    }

    const reason = stopRequested ? 'stopped' : 'completed';
    console.log(`Finished Facebook Reels doomscroll: reelsViewed=${reelsViewed} swipes=${swipes} likes=${likes} alreadyLiked=${alreadyLiked} translatedSkipped=${translatedSkipped} elapsedMs=${Date.now() - runStartedAt} reason=${reason}`);
} finally {
    if (driver) await driver.deleteSession();
}
