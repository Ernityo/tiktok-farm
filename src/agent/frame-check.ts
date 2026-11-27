// Compares WDA /screenshot (PNG) with a one-off MJPEG frame (JPEG) on whatever
// is on the phone's screen: how long each takes, and whether the app's checks
// (caption OCR, button rail, liked/saved, progress bar) read the same thing.
// Read-only: it only takes screenshots, no taps. Best on a paused video, so
// both frames show the same picture.
//
//   npm run agent:frame-check -- [--app tiktok|facebook] [--udid X] [--rounds 3] [--quality 80] [--quality 60]
//
// Frames are saved to .agent-runs/frame-check-<time>/ to look at.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { loadRegisteredDevices } from '@git-agni/phone-farm-core';
import sharp from 'sharp';

import { WdaRemoteControl } from '../devices/wda-remote.js';
import { detectReelsControls, detectTranslatedCaption } from '../facebook/reels-controls.js';
import { readReelProgress } from '../facebook/reels-progress.js';
import { readCaptionWords } from '../tiktok/ad-detection.js';
import { detectEngagementControls } from '../tiktok/engagement-controls.js';
import { coordinateProfile } from '../tiktok/runtime-settings.js';
import { readTikTokProgress } from '../tiktok/video-progress.js';
import { resolveDeviceCoordinates } from '../devices/coordinates.js';
import { resolveDevice } from './session.js';

const { values } = parseArgs({
    options: {
        app: { type: 'string', default: 'tiktok' },
        udid: { type: 'string' },
        rounds: { type: 'string', default: '3' },
        quality: { type: 'string', multiple: true },
    },
});
const rounds = Math.max(1, Number(values.rounds));
if (values.app !== 'tiktok' && values.app !== 'facebook') throw new Error('--app must be tiktok or facebook');
const app = values.app;
const qualities = (values.quality?.length ? values.quality : ['80']).map(Number);

const device = resolveDevice(await loadRegisteredDevices(), values.udid);
const coordinates = resolveDeviceCoordinates(coordinateProfile(device), device.coordinates);
const remote = new WdaRemoteControl({
    deviceUdid: device.udid,
    wdaUrl: process.env.WDA_URL ?? `http://127.0.0.1:${device.wdaLocalPort ?? Number(process.env.WDA_LOCAL_PORT ?? 8100)}`,
    mjpegUrl: process.env.MJPEG_URL ?? `http://127.0.0.1:${device.mjpegLocalPort ?? Number(process.env.MJPEG_LOCAL_PORT ?? 9100)}`,
});
const { scale } = await remote.getScreenInfo(device.udid);
const expectedGapPt = coordinates.tiktok.save.y - coordinates.tiktok.like.y;
const outDirectory = path.resolve('.agent-runs', `frame-check-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(outDirectory, { recursive: true });

async function timed<T>(run: () => Promise<T>): Promise<[T, number]> {
    const start = performance.now();
    const value = await run();
    return [value, Math.round(performance.now() - start)];
}

async function tiktokControls(frame: Buffer): Promise<string> {
    const controls = await detectEngagementControls(frame, scale, { expectedGapPt });
    return controls
        ? `like ${controls.like.x},${controls.like.y} save ${controls.save.x},${controls.save.y} liked=${controls.liked} saved=${controls.saved}`
        : 'not found';
}

async function facebookControls(frame: Buffer): Promise<string> {
    const [controls, translated] = await Promise.all([detectReelsControls(frame, scale), detectTranslatedCaption(frame, scale)]);
    const rail = controls ? `like ${controls.like.x},${controls.like.y} liked=${controls.liked}` : 'not found';
    return `${rail} translated=${translated.translated}`;
}

async function read(frame: Buffer) {
    const [meta, metaMs] = await timed(() => sharp(frame).metadata());
    // What the session does before the model call: the small model image.
    const [, imageMs] = await timed(() => sharp(frame).resize({ width: 384 }).jpeg({ quality: 60 }).toBuffer());
    const [words, ocrMs] = await timed(() => readCaptionWords(frame));
    const [controls, controlsMs] = await timed(() => app === 'tiktok' ? tiktokControls(frame) : facebookControls(frame));
    const [progress, progressMs] = await timed(() => app === 'tiktok' ? readTikTokProgress(frame, scale) : readReelProgress(frame, scale));
    return {
        size: `${meta.width}x${meta.height} ${meta.format} ${Math.round(frame.length / 1024)} KB`,
        caption: words.map((word) => word.text).join(' '),
        controls,
        progress: progress === undefined ? 'none' : progress.toFixed(2),
        ms: { decode: metaMs, modelImage: imageMs, ocr: ocrMs, controls: controlsMs, progress: progressMs },
    };
}

// The MJPEG settings are process-wide in WDA: note them now and put them back at the end.
const mjpegKeys = ['mjpegScalingFactor', 'mjpegServerScreenshotQuality', 'mjpegServerFramerate'];
const before = await remote.getSettings(device.udid);
const mjpegRestore = Object.fromEntries(mjpegKeys.filter((key) => before[key] !== undefined).map((key) => [key, before[key]]));

let mismatches = 0;
try {
    for (const quality of qualities) {
        await remote.updateSettings(device.udid, { mjpegScalingFactor: 100, mjpegServerScreenshotQuality: quality, mjpegServerFramerate: 30 });
        console.log(`\n=== ${app}, MJPEG quality ${quality}`);
        for (let round = 1; round <= rounds; round += 1) {
            const [png, pngMs] = await timed(() => remote.getScreenshot(device.udid));
            const [jpeg, jpegMs] = await timed(() => remote.getStreamFrame(device.udid, 3000));
            await writeFile(path.join(outDirectory, `q${quality}-${round}-screenshot.png`), png);
            await writeFile(path.join(outDirectory, `q${quality}-${round}-mjpeg.jpg`), jpeg);
            const [a, b] = await Promise.all([read(png), read(jpeg)]);
            console.log(`round ${round}: grab /screenshot ${pngMs} ms, mjpeg ${jpegMs} ms`);
            console.log(`  /screenshot ${a.size}  ${JSON.stringify(a.ms)}`);
            console.log(`  mjpeg       ${b.size}  ${JSON.stringify(b.ms)}`);
            for (const key of ['caption', 'controls', 'progress'] as const) {
                const same = a[key] === b[key];
                if (!same) mismatches += 1;
                console.log(`  ${same ? 'same' : 'DIFF'} ${key}: ${same ? a[key] : `\n    png:  ${a[key]}\n    jpeg: ${b[key]}`}`);
            }
        }
    }
} finally {
    if (Object.keys(mjpegRestore).length) await remote.updateSettings(device.udid, mjpegRestore).catch(() => undefined);
}
console.log(`\n${mismatches} mismatch(es). Frames in ${outDirectory}`);
console.log('A playing video changes between the two grabs (progress, sometimes the caption); pause it for a clean comparison.');
