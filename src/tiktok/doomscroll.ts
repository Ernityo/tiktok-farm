import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { remote, type Browser } from 'webdriverio';

import { loadRegisteredDevices, resolveDeviceCoordinates, WdaRemoteControl } from '@git-agni/phone-farm-core';
import { coordinateProfile, registeredAccounts } from './runtime-settings.js';
import { switchTikTokAccount, tapCoordinate } from './actions.js';
import { detectEngagementControls, type EngagementControls } from './engagement-controls.js';
import {
    PROFILES,
    clampToDeadline,
    decideLike,
    decideLinger,
    decideSave,
    hasTimeRemaining,
    isPersonality,
    pickWatchDurationMs,
} from './doomscroll-profile.js';

function positiveInteger(name: string, fallback: number): number {
    const rawValue = process.env[name] ?? String(fallback);
    const value = Number.parseInt(rawValue, 10);
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer; received ${rawValue}`);
    }
    return value;
}

function boundedInteger(name: string, fallback: number, min: number, max: number): number {
    const value = positiveInteger(name, fallback);
    if (value < min || value > max) {
        throw new Error(`${name} must be between ${min} and ${max}; received ${value}`);
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
if (!udid) {
    throw new Error('IOS_UDID is required. Copy .env.example to .env and set the connected device UDID.');
}

const personalityRaw = process.env.DOOMSCROLL_PERSONALITY ?? 'casual';
if (!isPersonality(personalityRaw)) {
    throw new Error(`DOOMSCROLL_PERSONALITY must be one of skimmer, casual, engaged; received ${personalityRaw}`);
}
const personality = personalityRaw;
const profile = PROFILES[personality];

const durationMinutes = boundedInteger('DOOMSCROLL_DURATION_MINUTES', 5, 1, 180);
const likeEnabled = booleanEnv('DOOMSCROLL_LIKE_ENABLED', true);
const saveEnabled = booleanEnv('DOOMSCROLL_SAVE_ENABLED', true);
const switchAccountName = process.env.TIKTOK_SWITCH_ACCOUNT?.trim() || undefined;
const registeredDevice = (await loadRegisteredDevices()).find((device) => device.udid === udid);
const coordinates = resolveDeviceCoordinates(coordinateProfile(registeredDevice), registeredDevice?.coordinates);
const tiktokCoordinates = coordinates.tiktok;
const accountSwitchCoords = {
    profileTabX: tiktokCoordinates.profileTab.x,
    profileTabY: tiktokCoordinates.profileTab.y,
    switcherTriggerX: tiktokCoordinates.accountSwitcher.x,
    switcherTriggerY: tiktokCoordinates.accountSwitcher.y,
};
// switchTikTokAccount ends on the Profile tab (it re-checks there to verify
// the switch). The scroll loop below expects the Home feed, so only
// doomscroll needs to navigate back — tiktok-post.ts's Create button works
// from any bottom-nav tab.
const { x: homeTabX, y: homeTabY } = tiktokCoordinates.homeTab;

// Fail fast, before unlocking or launching TikTok, if the requested account
// isn't one this device is registered for.
const allowedAccounts = switchAccountName
    ? registeredAccounts(registeredDevice)
    : [];
if (switchAccountName && !allowedAccounts.includes(switchAccountName)) {
    throw new Error(`TikTok account "${switchAccountName}" is not listed in devices.json for device ${udid}`);
}
// The like/save buttons move up and down between videos (music credits, long
// captions), so they are located on screen per video. The profile values only
// tell the detector how far apart the heart and bookmark are.
const expectedRailGapPt = tiktokCoordinates.save.y - tiktokCoordinates.like.y;
const { x: swipeX, startY: swipeStartY, endY: swipeEndY, durationMs: swipeDurationMs } = tiktokCoordinates.swipe;
const wdaUrl = process.env.WDA_URL;
const tiktokBundleId = process.env.TIKTOK_BUNDLE_ID ?? 'com.zhiliaoapp.musically';

const capabilities: WebdriverIO.Capabilities & Record<string, unknown> = {
    platformName: 'iOS',
    'appium:automationName': 'XCUITest',
    'appium:udid': udid,
    'appium:bundleId': tiktokBundleId,
    'appium:noReset': true,
    'appium:forceAppLaunch': true,
    'appium:shouldTerminateApp': true,
    'appium:newCommandTimeout': 120,
    'appium:wdaLaunchTimeout': 120000,
    'appium:wdaConnectionTimeout': 120000,
    // TikTok's video feed never becomes fully idle. Waiting for quiescence can
    // make otherwise-completed gestures block until the WDA proxy times out.
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
if (!wdaUrl && process.env.WDA_BUNDLE_ID) {
    capabilities['appium:updatedWDABundleId'] = process.env.WDA_BUNDLE_ID;
}
if (!wdaUrl && process.env.ALLOW_PROVISIONING_DEVICE_REGISTRATION === 'true') {
    capabilities['appium:allowProvisioningDeviceRegistration'] = true;
}
if (!wdaUrl && process.env.WDA_BOOTSTRAP_PATH) {
    capabilities['appium:useXctestrunFile'] = true;
    capabilities['appium:bootstrapPath'] = process.env.WDA_BOOTSTRAP_PATH;
}

// Cooperative cancellation: a Stop request sends SIGTERM (see
// src/automations/runner.ts). Every wait below races against stopPromise so
// a stop interrupts immediately instead of waiting out the current sleep.
let stopRequested = false;
let resolveStop: () => void = () => {};
const stopPromise = new Promise<void>((resolve) => { resolveStop = resolve; });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
        stopRequested = true;
        resolveStop();
    });
}

function cancellableDelay(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        void stopPromise.then(() => {
            clearTimeout(timer);
            resolve();
        });
    });
}

function interactionPauseMs(): number {
    return Math.round(200 + Math.random() * 400);
}

let driver: Browser | undefined;
let videosViewed = 0;
let swipes = 0;
let likes = 0;
let saves = 0;
const runStartedAt = Date.now();

console.log(`Starting doomscroll: profile=${personality} requestedDurationMinutes=${durationMinutes} likeEnabled=${likeEnabled} saveEnabled=${saveEnabled}`);

try {
    const remoteControl = new WdaRemoteControl({
        deviceUdid: udid,
        wdaUrl,
        passcodeKeypadLayout: coordinates.passcodeKeypad,
    });
    console.log('Checking device lock state');
    await remoteControl.unlock(udid);

    console.log(`Opening TikTok on ${udid}`);
    driver = await remote({
        hostname: process.env.APPIUM_HOST ?? '127.0.0.1',
        port: positiveInteger('APPIUM_PORT', 4725),
        path: '/',
        logLevel: 'info',
        connectionRetryCount: 0,
        connectionRetryTimeout: 180000,
        capabilities,
    });

    await driver.updateSettings({ defaultActiveApplication: tiktokBundleId });
    await driver.pause(3000);

    if (switchAccountName) {
        console.log(`Switching to TikTok account "${switchAccountName}"`);
        await switchTikTokAccount(driver, remoteControl, udid, switchAccountName, accountSwitchCoords);
        // switchTikTokAccount leaves the app on the Profile tab; the loop
        // below expects the Home feed.
        await tapCoordinate(driver, homeTabX, homeTabY, 'Home tab');
        await driver.pause(1500);
    }

    const { scale } = await remoteControl.getScreenInfo(udid);

    // Locates the like/save buttons on the video currently on screen.
    // Undefined means "not confident" — the caller skips the tap rather than
    // risk hitting Follow, a link, or the video itself.
    // Debug mode (DOOMSCROLL_DEBUG_DIR=<folder>): saves a screenshot before and
    // after every like/save/swipe so each tap can be reviewed afterwards.
    // Adds ~1 s of settle time per screenshot; off by default.
    const debugDir = process.env.DOOMSCROLL_DEBUG_DIR ? path.resolve(process.env.DOOMSCROLL_DEBUG_DIR) : undefined;
    let debugSequence = 0;
    const debugShot = async (label: string, screenshot?: Buffer, settleMs = 0): Promise<void> => {
        if (!debugDir) return;
        try {
            if (settleMs) await driver!.pause(settleMs);
            await mkdir(debugDir, { recursive: true });
            debugSequence += 1;
            const file = path.join(debugDir, `${String(debugSequence).padStart(3, '0')}-video${videosViewed}-${label}.png`);
            await writeFile(file, screenshot ?? await remoteControl.getScreenshot(udid));
            console.log(`[debug] screenshot ${file}`);
        } catch (error) {
            console.log(`[debug] screenshot failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    };

    const locateControls = async (): Promise<EngagementControls | undefined> => {
        try {
            const screenshot = await remoteControl.getScreenshot(udid);
            await debugShot('detect', screenshot);
            const detected = await detectEngagementControls(
                screenshot, scale, { expectedGapPt: expectedRailGapPt },
            );
            if (detected) {
                console.log(`Detected controls: like=(${detected.like.x}, ${detected.like.y}) save=(${detected.save.x}, ${detected.save.y}) confidence=${detected.confidence.toFixed(3)} alreadyLiked=${detected.liked} alreadySaved=${detected.saved}`);
            } else {
                console.log('Could not confidently detect like/save on this video; skipping engagement');
            }
            return detected;
        } catch (error) {
            console.log(`Control detection failed; skipping engagement: ${error instanceof Error ? error.message : String(error)}`);
            return undefined;
        }
    };

    const deadline = Date.now() + durationMinutes * 60_000;

    while (!stopRequested && hasTimeRemaining(Date.now(), deadline)) {
        await cancellableDelay(clampToDeadline(Date.now(), deadline, pickWatchDurationMs(profile)));
        videosViewed += 1;
        if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;

        const wantLike = likeEnabled && decideLike(profile);
        const wantSave = saveEnabled && decideSave(profile);
        const controls = wantLike || wantSave ? await locateControls() : undefined;
        if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;

        // The heart and bookmark are toggles: tapping an already-liked/saved
        // video would undo it, so those taps are skipped.
        if (wantLike && controls && !controls.liked) {
            await cancellableDelay(clampToDeadline(Date.now(), deadline, interactionPauseMs()));
            if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;
            await tapCoordinate(driver, controls.like.x, controls.like.y, 'Like');
            likes += 1;
            await debugShot('after-like', undefined, 800);
        }
        if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;

        if (wantSave && controls && !controls.saved) {
            await cancellableDelay(clampToDeadline(Date.now(), deadline, interactionPauseMs()));
            if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;
            await tapCoordinate(driver, controls.save.x, controls.save.y, 'Save');
            saves += 1;
            await debugShot('after-save', undefined, 800);
        }
        if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;

        const { linger, extraMs } = decideLinger(profile);
        if (linger) {
            await cancellableDelay(clampToDeadline(Date.now(), deadline, extraMs));
        }
        if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;

        await cancellableDelay(clampToDeadline(Date.now(), deadline, interactionPauseMs()));
        if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;

        await debugShot('before-swipe');
        // Coordinate actions bypass XCTest's expensive application-element
        // lookup, which can hang on TikTok's continuously updating feed.
        await driver.performActions([{
            type: 'pointer',
            id: 'finger',
            parameters: { pointerType: 'touch' },
            actions: [
                { type: 'pointerMove', duration: 0, x: swipeX, y: swipeStartY },
                { type: 'pointerDown', button: 0 },
                { type: 'pause', duration: 100 },
                { type: 'pointerMove', duration: swipeDurationMs, x: swipeX, y: swipeEndY },
                { type: 'pointerUp', button: 0 },
            ],
        }]);
        await driver.releaseActions();
        swipes += 1;
        console.log(`Swiped (${swipeX}, ${swipeStartY}) -> (${swipeX}, ${swipeEndY})`);
        await debugShot('after-swipe', undefined, 1000);
    }

    const elapsedMs = Date.now() - runStartedAt;
    const reason = stopRequested ? 'stopped' : 'completed';
    console.log(`Finished doomscroll: videosViewed=${videosViewed} swipes=${swipes} likes=${likes} saves=${saves} elapsedMs=${elapsedMs} reason=${reason}`);
} finally {
    if (driver) {
        await driver.deleteSession();
    }
}
