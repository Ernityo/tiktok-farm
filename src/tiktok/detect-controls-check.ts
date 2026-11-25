// Read-only check of TikTok like/save detection. Never taps the phone.
//
//   npm run detect:check                       # live screenshot from WDA
//   npm run detect:check -- --image shot.png   # offline, a saved screenshot
//   npm run detect:check -- --image shot.png --scale 3
//
// Writes to .wda/:
//   detect-check-<ts>.png      annotated: green = detected (what doomscroll
//                              taps), blue = comment, red cross = profile coords
//   detect-check-<ts>-raw.png  the untouched screenshot, reusable with --image
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

import { loadRegisteredDevices, resolveDeviceCoordinates, WdaRemoteControl } from '@git-agni/phone-farm-core';
import { detectAd } from './ad-detection.js';
import { detectEngagementControls, MIN_RAIL_CONFIDENCE } from './engagement-controls.js';
import { coordinateProfile } from './runtime-settings.js';

function argValue(name: string): string | undefined {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

const imagePath = argValue('--image');
const devices = await loadRegisteredDevices();
const udid = argValue('--udid') ?? process.env.IOS_UDID ?? (devices.length === 1 ? devices[0]!.udid : undefined);
const device = devices.find((entry) => entry.udid === udid);
const profileName = coordinateProfile(device);
const fallback = resolveDeviceCoordinates(profileName, device?.coordinates).tiktok;

let screenshot: Buffer;
let scale: number;
if (imagePath) {
    screenshot = await readFile(imagePath);
    scale = Number(argValue('--scale') ?? 2);
    console.log(`Using image ${imagePath} (scale ${scale})`);
} else {
    if (!udid) throw new Error('Pass --udid or set IOS_UDID (more than one device is registered).');
    const remote = new WdaRemoteControl({ deviceUdid: udid, wdaUrl: process.env.WDA_URL ?? `http://127.0.0.1:${device?.wdaLocalPort ?? 8100}` });
    [screenshot, { scale }] = await Promise.all([remote.getScreenshot(udid), remote.getScreenInfo(udid)]);
    console.log(`Took live screenshot from ${udid} (scale ${scale})`);
}

const started = Date.now();
const detected = await detectEngagementControls(screenshot, scale, { expectedGapPt: fallback.save.y - fallback.like.y });
const elapsedMs = Date.now() - started;

console.log(`Profile "${profileName}" coords: like=(${fallback.like.x}, ${fallback.like.y}) save=(${fallback.save.x}, ${fallback.save.y})`);
if (detected) {
    const shift = detected.like.y - fallback.like.y;
    console.log(`DETECTED (confidence ${detected.confidence.toFixed(3)}, threshold ${MIN_RAIL_CONFIDENCE}, ${elapsedMs} ms):`);
    console.log(`  like=(${detected.like.x}, ${detected.like.y})  comment=(${detected.comment.x}, ${detected.comment.y})  save=(${detected.save.x}, ${detected.save.y})`);
    console.log(`  already liked: ${detected.liked ? 'yes (like would be skipped)' : 'no'}   already saved: ${detected.saved ? 'yes (save would be skipped)' : 'no'}`);
    console.log(`  rail is ${Math.abs(shift)} pt ${shift < 0 ? 'higher' : 'lower'} than the profile coords`);
} else {
    console.log(`NOT DETECTED (${elapsedMs} ms) — doomscroll would skip like/save on this video.`);
}

const ad = await detectAd(screenshot);
const swipe = fallback.swipe;
console.log(ad.isAd
    ? `AD (label "${ad.label}") — swipe would start at y=${swipe.adStartY} instead of ${swipe.startY}`
    : `Not an ad — swipe would start at y=${swipe.startY}`);

const { width = 0, height = 0 } = await sharp(screenshot).metadata();
const px = (value: number) => Math.round(value * scale);
const cross = (p: { x: number; y: number }) =>
    `<line x1="${px(p.x) - 30}" y1="${px(p.y)}" x2="${px(p.x) + 30}" y2="${px(p.y)}" stroke="red" stroke-width="5"/>`
    + `<line x1="${px(p.x)}" y1="${px(p.y) - 30}" x2="${px(p.x)}" y2="${px(p.y) + 30}" stroke="red" stroke-width="5"/>`;
const circle = (p: { x: number; y: number }, color: string) =>
    `<circle cx="${px(p.x)}" cy="${px(p.y)}" r="${Math.round(24 * scale)}" fill="none" stroke="${color}" stroke-width="6"/>`;
const overlay = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
    + cross(fallback.like) + cross(fallback.save)
    + (detected ? circle(detected.like, 'lime') + circle(detected.comment, 'deepskyblue') + circle(detected.save, 'lime') : '')
    + '</svg>';

const stamp = Date.now();
const outPath = path.resolve('.wda', `detect-check-${stamp}.png`);
await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, await sharp(screenshot).composite([{ input: Buffer.from(overlay) }]).png().toBuffer());
if (!imagePath) await writeFile(path.resolve('.wda', `detect-check-${stamp}-raw.png`), screenshot);
console.log(`Annotated screenshot: ${outPath}`);
