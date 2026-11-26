import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import sharp from 'sharp';
import { remote, type Browser } from 'webdriverio';

import {
    activeDevices, loadRegisteredDevices, resolveDeviceCoordinates, WdaRemoteControl,
} from '@git-agni/phone-farm-core';
import type { RegisteredDevice } from '../devices/registry.js';
import { appLaunchSettleMs, performSwipe, swipeCoordinates, tapCoordinate } from './actions.js';
import { profileSwipe, resolveSwipeStyle, type SwipeProfile, type SwipeStyle } from '../devices/swipe-profiles.js';
import { adFromWords, detectAdStrict, readCaptionWords, type AdDetection } from './ad-detection.js';
import { engagementAllowance, FULL_WATCH_CAP_MS, sameCaption, SHOP_POST, timePlan, type AgentPlan, type TimedPlan } from './agent-plan.js';
import { ReelWatchTracker } from '../facebook/reels-progress.js';
import { PROFILES, type Personality } from './doomscroll-profile.js';
import { detectEngagementControls, type EngagementControls } from './engagement-controls.js';
import type { OcrWord } from './ocr.js';
import { nicheForAccount, normalizeHandle, type Niche } from './niche.js';
import { coordinateProfile, registeredAccounts } from './runtime-settings.js';
import { readTikTokProgress } from './video-progress.js';

// One agentic doomscroll session on one phone: the agent (a Claude Code
// session, through the MCP tools in agent-mcp.ts) sees each video once, and
// this class carries out its plan with the same detectors and humanized
// gestures as the programmatic doomscroll.

function envInteger(name: string, fallback: number, min: number, max: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`${name} must be an integer between ${min} and ${max}; received ${raw}`);
    }
    return value;
}

/** Wait after a swipe before the screenshot: the caption shows on the first frame. */
const SETTLE_MS = envInteger('AGENT_SETTLE_MS', 400, 0, 5000);
/** Width of the JPEG sent to the agent; smaller = fewer tokens. */
const IMAGE_WIDTH = envInteger('AGENT_IMAGE_WIDTH', 384, 160, 1200);
const IMAGE_QUALITY = envInteger('AGENT_IMAGE_QUALITY', 60, 20, 95);
const CAPTION_MAX_CHARS = 400;
/**
 * Caption area (left of the button rail, above the tab bar) sent at full
 * resolution as a second image: small grey text such as TikTok's translation
 * link ("Voir l'original") is unreadable in the downscaled screenshot.
 */
const CAPTION_CROP = { left: 0, top: 0.62, width: 0.85, height: 0.3 };
const CAPTION_CROP_WIDTH = 640;
/** Extra swipes when the feed did not move on (same caption as before). */
const MAX_SWIPE_RETRIES = 2;


const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

export interface StartOptions {
    minutes: number;
    /** Caps likes/saves and sets watch lengths, like the programmatic profiles. */
    personality: Personality;
    udid?: string;
    account?: string;
    /** Overrides the account's saved niche (or stands in when no account is given). */
    niche?: Niche;
    /** Thumb-side swipe style; defaults to right-thumb. 'fixed' uses the old swipe. */
    swipeStyle?: SwipeStyle;
}

export interface Observation {
    video: number;
    /** Small JPEG of the screen. */
    image: Buffer;
    /** The caption area at full resolution (JPEG). */
    captionImage: Buffer;
    /** OCR of the caption area: handle, caption, hashtags, sound name. Can be noisy. */
    caption: string;
    isAd: boolean;
    remainingMs: number;
    /** Likes/saves done so far, and how many the rate allows if this video is liked/saved. */
    engagement: { likes: number; likesAllowed: number; saves: number; savesAllowed: number };
}

export interface SessionSummary {
    reason: 'completed' | 'stopped' | 'error';
    account?: string;
    personality: Personality;
    videos: number;
    onNiche: number;
    onNicheShare: number;
    skips: number;
    likes: number;
    saves: number;
    /** Share of judged videos liked / saved. */
    likeRate: number;
    saveRate: number;
    ads: number;
    /** Time from a screenshot being returned to the agent's plan arriving. */
    medianDecisionMs?: number;
    /** Screen time of skipped videos, from the swipe landing to the next swipe. */
    medianSkipScreenMs?: number;
    elapsedMs: number;
    logDirectory: string;
}

interface CurrentVideo {
    index: number;
    /** When the swipe that brought this video in finished. */
    arrivedAt: number;
    observedAt: number;
    caption: string;
    ad: AdDetection;
    /** The stricter second ad pass, running while the agent thinks. */
    strictAd: Promise<AdDetection>;
}

function median(values: readonly number[]): number | undefined {
    if (!values.length) return undefined;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

function resolveDevice(devices: readonly RegisteredDevice[], udid: string | undefined): RegisteredDevice {
    const wanted = udid ?? process.env.IOS_UDID;
    if (wanted) {
        const device = devices.find((entry) => entry.udid === wanted);
        if (!device) throw new Error(`Device ${wanted} is not registered in devices.json`);
        if (device.disabled) throw new Error(`Device ${wanted} is disconnected in the dashboard; reconnect it first`);
        return device;
    }
    const active = activeDevices(devices);
    if (active.length === 1) return active[0]!;
    const list = active.map((device) => `${device.name.trim() || 'unnamed'} (${device.udid})`).join(', ') || 'none';
    throw new Error(`Pass udid: ${active.length} active devices are registered: ${list}`);
}

export class TikTokAgentSession {
    private current: CurrentVideo | undefined;
    private busy = false;
    private closed: SessionSummary | undefined;
    /** Videos observed so far (numbers the screenshots). */
    private videos = 0;
    private onNiche = 0;
    private skips = 0;
    private likes = 0;
    private saves = 0;
    private ads = 0;
    private readonly decisionMs: number[] = [];
    private readonly skipScreenMs: number[] = [];
    private readonly startedAt = Date.now();

    private constructor(
        private readonly driver: Browser,
        private readonly remoteControl: WdaRemoteControl,
        private readonly device: RegisteredDevice,
        private readonly coordinates: ReturnType<typeof resolveDeviceCoordinates>['tiktok'],
        private readonly scale: number,
        private readonly deadline: number,
        private readonly logDirectory: string,
        readonly account: string | undefined,
        readonly niche: Niche,
        readonly personality: Personality,
        private readonly swipeStyle: SwipeProfile | undefined,
    ) {}

    /** Unlocks the phone, opens TikTok (already on the account), and observes the first video. */
    static async start(options: StartOptions): Promise<{ session: TikTokAgentSession; observation: Observation }> {
        const device = resolveDevice(await loadRegisteredDevices(), options.udid);
        const account = options.account ? normalizeHandle(options.account) : undefined;
        if (account && !registeredAccounts(device).map(normalizeHandle).includes(account)) {
            throw new Error(`${account} is not one of this device's TikTok accounts (dashboard → Accounts)`);
        }
        const niche = options.niche ?? (account ? nicheForAccount(device, account) : undefined);
        if (!niche) {
            throw new Error(account
                ? `${account} has no niche yet: set it in the dashboard (Niches), or pass one`
                : 'Pass an account that has a niche, or pass a niche');
        }

        const coordinates = resolveDeviceCoordinates(coordinateProfile(device), device.coordinates);
        const swipeStyle = resolveSwipeStyle(options.swipeStyle, coordinateProfile(device));
        const wdaUrl = process.env.WDA_URL ?? `http://127.0.0.1:${device.wdaLocalPort ?? Number(process.env.WDA_LOCAL_PORT ?? 8100)}`;
        const bundleId = process.env.TIKTOK_BUNDLE_ID ?? 'com.zhiliaoapp.musically';
        const remoteControl = new WdaRemoteControl({
            deviceUdid: device.udid,
            wdaUrl,
            passcode: device.passcode ?? process.env.IOS_PASSCODE,
            passcodeKeypadLayout: coordinates.passcodeKeypad,
        });
        console.log(`[agent] unlocking ${device.udid}`);
        await remoteControl.unlock(device.udid);

        console.log('[agent] opening TikTok');
        const driver = await remote({
            hostname: process.env.APPIUM_HOST ?? '127.0.0.1',
            port: Number(process.env.APPIUM_PORT ?? 4725),
            path: '/',
            logLevel: 'warn',
            connectionRetryCount: 0,
            connectionRetryTimeout: 180000,
            capabilities: {
                platformName: 'iOS',
                'appium:automationName': 'XCUITest',
                'appium:udid': device.udid,
                'appium:bundleId': bundleId,
                'appium:noReset': true,
                'appium:forceAppLaunch': true,
                'appium:shouldTerminateApp': true,
                // The agent thinks between calls; keep the session alive.
                'appium:newCommandTimeout': 300,
                'appium:waitForIdleTimeout': 0,
                'appium:webDriverAgentUrl': wdaUrl,
                'appium:wdaRemotePort': device.wdaRemotePort ?? Number(process.env.WDA_REMOTE_PORT ?? 8100),
            } as WebdriverIO.Capabilities,
        });
        try {
            await driver.updateSettings({ defaultActiveApplication: bundleId });
            await driver.pause(appLaunchSettleMs()); // let a launch ad settle
            const tiktok = coordinates.tiktok;
            // No account switching for now: the phone must already be on `account`,
            // which only selects the niche.
            const { scale } = await remoteControl.getScreenInfo(device.udid);
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const logDirectory = path.resolve('.agent-runs', `${stamp}-${(account ?? 'current').replace(/^@/, '')}`);
            await mkdir(logDirectory, { recursive: true });
            await writeFile(path.join(logDirectory, 'session.json'), JSON.stringify({
                udid: device.udid, account, niche, personality: options.personality, minutes: options.minutes, startedAt: new Date().toISOString(),
            }, null, 2));
            const session = new TikTokAgentSession(
                driver, remoteControl, device, tiktok, scale, Date.now() + options.minutes * 60_000, logDirectory, account, niche,
                options.personality, swipeStyle,
            );
            const observation = await session.observe(Date.now());
            return { session, observation };
        } catch (error) {
            await driver.deleteSession().catch(() => undefined);
            throw error;
        }
    }

    get remainingMs(): number {
        return Math.max(0, this.deadline - Date.now());
    }

    private async capture(): Promise<{ screenshot: Buffer; words: OcrWord[]; image: Buffer; captionImage: Buffer; caption: string }> {
        await sleep(SETTLE_MS);
        const screenshot = await this.remoteControl.getScreenshot(this.device.udid);
        const [words, image, captionImage] = await Promise.all([
            readCaptionWords(screenshot).catch((): OcrWord[] => []),
            sharp(screenshot).resize({ width: IMAGE_WIDTH }).jpeg({ quality: IMAGE_QUALITY }).toBuffer(),
            this.captionCrop(screenshot),
        ]);
        return { screenshot, words, image, captionImage, caption: words.map((word) => word.text).join(' ').slice(0, CAPTION_MAX_CHARS) };
    }

    private async captionCrop(screenshot: Buffer): Promise<Buffer> {
        const { width = 0, height = 0 } = await sharp(screenshot).metadata();
        return sharp(screenshot)
            .extract({
                left: Math.round(width * CAPTION_CROP.left),
                top: Math.round(height * CAPTION_CROP.top),
                width: Math.round(width * CAPTION_CROP.width),
                height: Math.round(height * CAPTION_CROP.height),
            })
            .resize({ width: CAPTION_CROP_WIDTH, withoutEnlargement: true })
            .jpeg({ quality: 70 })
            .toBuffer();
    }

    private async observe(arrivedAt: number, previousCaption?: string): Promise<Observation> {
        let { screenshot, words, image, captionImage, caption } = await this.capture();
        // A swipe can fail to move the feed on (seen on TikTok Shop posts):
        // the same video is still there, so swipe again from higher up.
        for (let retry = 1; retry <= MAX_SWIPE_RETRIES && previousCaption && sameCaption(previousCaption, caption); retry++) {
            console.log(`[agent] swipe did not move the feed on; swiping again (${retry}/${MAX_SWIPE_RETRIES})`);
            await this.swipe(true);
            arrivedAt = Date.now();
            ({ screenshot, words, image, captionImage, caption } = await this.capture());
        }
        const ad = adFromWords(words);
        this.videos += 1;
        this.current = {
            index: this.videos,
            arrivedAt,
            observedAt: Date.now(),
            caption,
            ad,
            strictAd: ad.isAd ? Promise.resolve(ad) : detectAdStrict(screenshot).catch(() => ({ isAd: false })),
        };
        const stem = path.join(this.logDirectory, String(this.videos).padStart(4, '0'));
        await Promise.all([
            writeFile(`${stem}.jpg`, image).catch(() => undefined),
            writeFile(`${stem}-caption.jpg`, captionImage).catch(() => undefined),
        ]);
        const judgedIncludingThis = this.decisionMs.length + 1;
        const profile = PROFILES[this.personality];
        return {
            video: this.videos, image, captionImage, caption, isAd: ad.isAd, remainingMs: this.remainingMs,
            engagement: {
                likes: this.likes, likesAllowed: engagementAllowance(judgedIncludingThis, profile.likeChance),
                saves: this.saves, savesAllowed: engagementAllowance(judgedIncludingThis, profile.saveChance),
            },
        };
    }

    private async locateControls(): Promise<EngagementControls | undefined> {
        try {
            const screenshot = await this.remoteControl.getScreenshot(this.device.udid);
            return await detectEngagementControls(screenshot, this.scale, {
                expectedGapPt: this.coordinates.save.y - this.coordinates.like.y,
            });
        } catch (error) {
            console.log(`[agent] control detection failed: ${error instanceof Error ? error.message : String(error)}`);
            return undefined;
        }
    }

    /**
     * Carries out the plan for the current video, swipes, and observes the
     * next one. Returns a summary instead once the session time is up.
     * `logExtra` is added to this video's line in decisions.jsonl.
     */
    async step(plan: AgentPlan, logExtra: Record<string, unknown> = {}): Promise<{ observation: Observation } | { summary: SessionSummary }> {
        if (this.closed) return { summary: this.closed };
        if (this.busy) throw new Error('A step is already running');
        const video = this.current;
        if (!video) throw new Error('No video observed yet');
        this.busy = true;
        try {
            const decidedAt = Date.now();
            const timed: TimedPlan = timePlan(plan, this.remainingMs, this.personality, {
                judged: this.decisionMs.length, likes: this.likes, saves: this.saves,
            });
            this.decisionMs.push(decidedAt - video.observedAt);
            const wantsTap = timed.likeAtMs !== undefined || timed.saveAtMs !== undefined;
            const controls = wantsTap ? await this.locateControls() : undefined;
            let liked = false;
            let saved = false;
            if (wantsTap && !controls) console.log('[agent] like/save skipped: controls not found confidently');

            const actions: Array<{ at: number; kind: 'like' | 'save' }> = [];
            if (timed.likeAtMs !== undefined) actions.push({ at: timed.likeAtMs, kind: 'like' });
            if (timed.saveAtMs !== undefined) actions.push({ at: timed.saveAtMs, kind: 'save' });
            actions.sort((a, b) => a.at - b.at);
            for (const action of actions) {
                await sleep(decidedAt + action.at - Date.now());
                if (!controls) continue;
                // Heart and bookmark are toggles: never undo an existing like/save.
                if (action.kind === 'like' && !controls.liked) {
                    await tapCoordinate(this.driver, controls.like.x, controls.like.y, 'Like');
                    liked = true;
                    this.likes += 1;
                }
                if (action.kind === 'save' && !controls.saved) {
                    await tapCoordinate(this.driver, controls.save.x, controls.save.y, 'Save');
                    saved = true;
                    this.saves += 1;
                }
            }
            const watched = plan.watch === 'full'
                ? await this.watchToEnd(decidedAt, timed.watchMs)
                : (await sleep(decidedAt + timed.watchMs - Date.now()), { by: 'timer' as const });

            const ad = await video.strictAd;
            if (ad.isAd) this.ads += 1;
            if (plan.onNiche >= 0.5) this.onNiche += 1;
            if (plan.watch === 'skip') {
                this.skips += 1;
                this.skipScreenMs.push(Date.now() - video.arrivedAt);
            }
            await this.swipe(ad.isAd || SHOP_POST.test(video.caption));
            const arrivedAt = Date.now();

            await appendFile(path.join(this.logDirectory, 'decisions.jsonl'), `${JSON.stringify({
                video: video.index, caption: video.caption, isAd: ad.isAd, plan, timed, watched, liked, saved,
                decisionMs: decidedAt - video.observedAt, screenMs: arrivedAt - video.arrivedAt, ...logExtra,
            })}\n`).catch(() => undefined);

            if (this.remainingMs <= 0) return { summary: await this.stop('completed') };
            return { observation: await this.observe(arrivedAt, video.caption) };
        } finally {
            this.busy = false;
        }
    }

    /**
     * Keeps a `full` video on screen until it has played to the end, read
     * from TikTok's progress bar (it loops, so the end shows as the fill
     * jumping back to the start). Videos without a bar (short ones) fall back
     * to the timed watch. Capped per personality and by the session deadline.
     */
    private async watchToEnd(decidedAt: number, timedWatchMs: number): Promise<
        { by: 'progress'; completed: boolean; lastProgress: number; videoMs?: number } | { by: 'timer' }
    > {
        const capEnd = Math.min(decidedAt + FULL_WATCH_CAP_MS[this.personality], this.deadline);
        const tracker = new ReelWatchTracker();
        let lastProgress: number | undefined;
        let misses = 0;
        while (Date.now() < capEnd) {
            let progress: number | undefined;
            try {
                progress = await readTikTokProgress(await this.remoteControl.getScreenshot(this.device.udid), this.scale);
            } catch {
                progress = undefined;
            }
            if (progress === undefined) {
                misses += 1;
                // Two misses before any reading: this video has no bar.
                if (lastProgress === undefined && misses >= 2) break;
            } else {
                lastProgress = progress;
                const state = tracker.add({ atMs: Date.now(), progress });
                if (state.kind === 'completed' || progress >= 0.98) {
                    // Swipe a moment after the loop starts, like a person would.
                    await sleep(Math.min(300 + Math.random() * 1200, capEnd - Date.now()));
                    const videoMs = state.kind === 'completed' ? state.durationMs : undefined;
                    return { by: 'progress', completed: true, lastProgress: progress, ...(videoMs ? { videoMs } : {}) };
                }
            }
            await sleep(Math.min(900, capEnd - Date.now()));
        }
        if (lastProgress === undefined) {
            await sleep(decidedAt + timedWatchMs - Date.now());
            return { by: 'timer' };
        }
        return { by: 'progress', completed: false, lastProgress };
    }

    private async swipe(isAd: boolean): Promise<void> {
        if (!isAd && this.swipeStyle) {
            await performSwipe(this.driver, profileSwipe(this.swipeStyle));
            return;
        }
        const { x, startY, adStartY, endY, durationMs } = this.coordinates.swipe;
        // Ads put forms and CTA buttons where the normal swipe starts, so the
        // swipe starts higher on ads, at the same finger speed.
        const fromY = isAd ? adStartY : startY;
        const duration = isAd ? Math.round(durationMs * (adStartY - endY) / (startY - endY)) : durationMs;
        await swipeCoordinates(this.driver, { x, y: fromY }, { x, y: endY }, duration, isAd ? { startRadius: { x: 18, y: 6 } } : {});
    }

    /** Ends the session (idempotent) and returns its summary. */
    async stop(reason: SessionSummary['reason'] = 'stopped'): Promise<SessionSummary> {
        if (this.closed) return this.closed;
        // Videos the agent decided on; the last one observed may not have been.
        const judged = this.decisionMs.length;
        const rate = (count: number) => (judged ? Math.round((count / judged) * 100) / 100 : 0);
        const summary: SessionSummary = {
            reason,
            ...(this.account ? { account: this.account } : {}),
            personality: this.personality,
            videos: judged,
            onNiche: this.onNiche,
            onNicheShare: rate(this.onNiche),
            skips: this.skips,
            likes: this.likes,
            saves: this.saves,
            likeRate: rate(this.likes),
            saveRate: rate(this.saves),
            ads: this.ads,
            medianDecisionMs: median(this.decisionMs),
            medianSkipScreenMs: median(this.skipScreenMs),
            elapsedMs: Date.now() - this.startedAt,
            logDirectory: this.logDirectory,
        };
        this.closed = summary;
        await writeFile(path.join(this.logDirectory, 'summary.json'), JSON.stringify(summary, null, 2)).catch(() => undefined);
        await this.driver.deleteSession().catch(() => undefined);
        return summary;
    }
}
