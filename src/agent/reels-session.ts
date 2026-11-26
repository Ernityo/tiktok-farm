import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import sharp from 'sharp';
import { remote, type Browser } from 'webdriverio';

import type { HumanSwipe } from '../devices/humanize.js';

import { loadRegisteredDevices, resolveDeviceCoordinates, WdaRemoteControl } from '@git-agni/phone-farm-core';
import type { RegisteredDevice } from '../devices/registry.js';
import { profileSwipe, resolveSwipeStyle, type SwipeProfile, type SwipeStyle } from '../devices/swipe-profiles.js';
import { ReelWatchTracker } from '../facebook/reels-progress.js';
import { appLaunchSettleMs, performSwipe, tapCoordinate } from '../tiktok/actions.js';
import { adFromWords, readCaptionWords } from '../tiktok/ad-detection.js';
import { engagementAllowance, finalLingerMs, FULL_WATCH_CAP_MS, sessionLengthMs, swipeRecord, timePlan, type AgentPlan, type SwipeRecord } from '../tiktok/agent-plan.js';
import { envInteger, median, resolveDevice, type Observation, type SessionSummary } from '../tiktok/agent-session.js';
import { PROFILES, type Personality } from '../tiktok/doomscroll-profile.js';
import { nicheForAccount, normalizeHandle, type Niche } from '../tiktok/niche.js';
import type { OcrWord } from '../tiktok/ocr.js';
import { coordinateProfile } from '../tiktok/runtime-settings.js';

// Agentic doomscroll for Reels-style feeds other than TikTok (Facebook,
// Instagram). Same contract as TikTokAgentSession — observe a video, take
// the model's plan, carry it out, swipe — with the app-specific parts
// (opening Reels, finding J'aime, reading progress, spotting ads/cards)
// behind a small adapter.

const SETTLE_MS = envInteger('AGENT_SETTLE_MS', 400, 0, 5000);
const IMAGE_WIDTH = envInteger('AGENT_IMAGE_WIDTH', 384, 160, 1200);
const IMAGE_QUALITY = envInteger('AGENT_IMAGE_QUALITY', 60, 20, 95);
const CAPTION_MAX_CHARS = 400;
/** Caption area (left of the button column, above the tab bar), sent at full resolution. */
const CAPTION_CROP = { left: 0, top: 0.6, width: 0.85, height: 0.32 };
const CAPTION_CROP_WIDTH = 640;
/** Screens in a row without Reel controls before stopping: we probably left Reels. */
const MAX_CARDS_IN_A_ROW = 6;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** What the session hands an adapter to act on the phone. */
export interface ReelsContext {
    driver: Browser;
    remoteControl: WdaRemoteControl;
    device: RegisteredDevice;
    coordinates: ReturnType<typeof resolveDeviceCoordinates>;
    /** Screen scale (points → pixels). */
    scale: number;
    window: { width: number; height: number };
    screenshot(): Promise<Buffer>;
}

/** What an adapter reads off a fresh video's screenshot. */
export interface ReelInspection {
    isAd: boolean;
    /** Skip without asking the model: 'card' (surely not a Reel), 'foreign' (translated caption), ... */
    autoSkip?: string;
    /** The Reel controls weren't found (the model still judges unless autoSkip says otherwise); many in a row stops the session. */
    noControls?: boolean;
    /** Tells one Reel from the next, when the app exposes it. */
    reelId?: string;
}

export interface ReelsAppAdapter {
    readonly app: 'facebook' | 'instagram';
    readonly label: string;
    readonly pluginId: string;
    readonly bundleId: string;
    /** From a cold launch to the first Reel; throws when Reels can't be confirmed. */
    openReels(context: ReelsContext): Promise<void>;
    inspect(context: ReelsContext, screenshot: Buffer): Promise<ReelInspection>;
    /** J'aime right now, or undefined when not confidently on screen. `reelId` = the Reel it must still be on. */
    locateLike(context: ReelsContext, reelId?: string): Promise<{ x: number; y: number; liked: boolean } | undefined>;
    /** Share of the video played, and the Reel now on screen (to notice the app moving on by itself). */
    readProgress(context: ReelsContext): Promise<{ progress?: number; reelId?: string }>;
    /** The Reel on screen now, when the app exposes it. */
    currentReelId?(context: ReelsContext): Promise<string | undefined>;
    /** Fixed upward swipe used when no thumb-side swipe style applies. */
    fixedSwipe(context: ReelsContext): Promise<HumanSwipe>;
}

export interface ReelsStartOptions {
    adapter: ReelsAppAdapter;
    minutes: number;
    personality: Personality;
    udid?: string;
    /** Selects the niche: the app's own niche for this handle, else the TikTok one. */
    account?: string;
    niche?: Niche;
    swipeStyle?: SwipeStyle;
}

interface CurrentVideo {
    index: number;
    arrivedAt: number;
    observedAt: number;
    caption: string;
    isAd: boolean;
    reelId?: string;
}

type WatchOutcome =
    | { by: 'progress'; completed: boolean; lastProgress: number; videoMs?: number }
    | { by: 'advanced'; lastProgress: number }
    | { by: 'timer' };

export class ReelsAgentSession {
    private current: CurrentVideo | undefined;
    private busy = false;
    private closed: SessionSummary | undefined;
    private videos = 0;
    private onNiche = 0;
    private skips = 0;
    private likes = 0;
    private ads = 0;
    private cardsInARow = 0;
    /** The app moved to the next Reel on its own: don't swipe past it. */
    private advancedOnItsOwn = false;
    private readonly decisionMs: number[] = [];
    private readonly skipScreenMs: number[] = [];
    private readonly startedAt = Date.now();

    private constructor(
        private readonly adapter: ReelsAppAdapter,
        private readonly context: ReelsContext,
        private readonly deadline: number,
        private readonly logDirectory: string,
        readonly account: string | undefined,
        readonly niche: Niche,
        readonly personality: Personality,
        private readonly swipeStyle: SwipeProfile | undefined,
    ) {}

    static async start(options: ReelsStartOptions): Promise<{ session: ReelsAgentSession; observation: Observation }> {
        const { adapter } = options;
        const device = resolveDevice(await loadRegisteredDevices(), options.udid);
        const account = options.account ? normalizeHandle(options.account) : undefined;
        const niche = options.niche
            ?? (account ? nicheForAccount(device, account, adapter.pluginId) ?? nicheForAccount(device, account) : undefined);
        if (!niche) {
            throw new Error(account
                ? `${account} has no niche on this device: pass --niche "...", or save one for it (device page → Niches)`
                : 'Pass --niche "...", or an --account that has a niche');
        }

        const coordinates = resolveDeviceCoordinates(coordinateProfile(device), device.coordinates);
        const swipeStyle = resolveSwipeStyle(options.swipeStyle, coordinateProfile(device));
        const wdaUrl = process.env.WDA_URL ?? `http://127.0.0.1:${device.wdaLocalPort ?? Number(process.env.WDA_LOCAL_PORT ?? 8100)}`;
        const remoteControl = new WdaRemoteControl({
            deviceUdid: device.udid,
            wdaUrl,
            passcode: device.passcode ?? process.env.IOS_PASSCODE,
            passcodeKeypadLayout: coordinates.passcodeKeypad,
        });
        console.log(`[agent] unlocking ${device.udid}`);
        await remoteControl.unlock(device.udid);

        console.log(`[agent] opening ${adapter.label}`);
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
                'appium:bundleId': adapter.bundleId,
                'appium:noReset': true,
                'appium:forceAppLaunch': true,
                'appium:shouldTerminateApp': true,
                'appium:newCommandTimeout': 300,
                // Reels autoplay video, so the app never becomes idle.
                'appium:waitForIdleTimeout': 0,
                'appium:webDriverAgentUrl': wdaUrl,
                'appium:wdaRemotePort': device.wdaRemotePort ?? Number(process.env.WDA_REMOTE_PORT ?? 8100),
            } as WebdriverIO.Capabilities,
        });
        try {
            await driver.updateSettings({ defaultActiveApplication: adapter.bundleId });
            await driver.pause(appLaunchSettleMs());
            const { scale } = await remoteControl.getScreenInfo(device.udid);
            const window = await driver.getWindowRect();
            const context: ReelsContext = {
                driver, remoteControl, device, coordinates, scale, window,
                screenshot: () => remoteControl.getScreenshot(device.udid),
            };
            await adapter.openReels(context);

            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const logDirectory = path.resolve('.agent-runs', `${stamp}-${adapter.app}-${(account ?? 'current').replace(/^@/, '')}`);
            await mkdir(logDirectory, { recursive: true });
            await writeFile(path.join(logDirectory, 'session.json'), JSON.stringify({
                app: adapter.app, udid: device.udid, account, niche, personality: options.personality, minutes: options.minutes,
                startedAt: new Date().toISOString(),
            }, null, 2));
            const session = new ReelsAgentSession(
                adapter, context, Date.now() + sessionLengthMs(options.minutes), logDirectory, account, niche, options.personality, swipeStyle,
            );
            return { session, observation: await session.observe(Date.now()) };
        } catch (error) {
            await driver.deleteSession().catch(() => undefined);
            throw error;
        }
    }

    get remainingMs(): number {
        return Math.max(0, this.deadline - Date.now());
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

    private async observe(arrivedAt: number): Promise<Observation> {
        await sleep(SETTLE_MS);
        const screenshot = await this.context.screenshot();
        const [words, image, captionImage, inspection] = await Promise.all([
            readCaptionWords(screenshot).catch((): OcrWord[] => []),
            sharp(screenshot).resize({ width: IMAGE_WIDTH }).jpeg({ quality: IMAGE_QUALITY }).toBuffer(),
            this.captionCrop(screenshot),
            this.adapter.inspect(this.context, screenshot),
        ]);
        const caption = words.map((word) => word.text).join(' ').slice(0, CAPTION_MAX_CHARS);
        const isAd = inspection.isAd || adFromWords(words).isAd;
        if (inspection.noControls || inspection.autoSkip === 'card') {
            this.cardsInARow += 1;
            if (this.cardsInARow >= MAX_CARDS_IN_A_ROW) {
                throw new Error(`No Reel on ${this.cardsInARow} screens in a row; ${this.adapter.label} is probably showing another screen`);
            }
        } else {
            this.cardsInARow = 0;
        }
        this.videos += 1;
        this.current = {
            index: this.videos, arrivedAt, observedAt: Date.now(), caption, isAd,
            ...(inspection.reelId ? { reelId: inspection.reelId } : {}),
        };
        const stem = path.join(this.logDirectory, String(this.videos).padStart(4, '0'));
        await Promise.all([
            writeFile(`${stem}.jpg`, image).catch(() => undefined),
            writeFile(`${stem}-caption.jpg`, captionImage).catch(() => undefined),
        ]);
        const judgedIncludingThis = this.decisionMs.length + 1;
        return {
            video: this.videos, image, captionImage, caption, isAd, remainingMs: this.remainingMs,
            // Saving isn't a one-tap action on these feeds.
            engagement: {
                likes: this.likes, likesAllowed: engagementAllowance(judgedIncludingThis, PROFILES[this.personality].likeChance),
                saves: 0, savesAllowed: 0,
            },
            ...(isAd ? { autoSkip: 'ad' } : inspection.autoSkip ? { autoSkip: inspection.autoSkip } : {}),
        };
    }

    /** Carries out the plan, swipes, and observes the next video (or returns the summary when time is up). */
    async step(plan: AgentPlan, logExtra: Record<string, unknown> = {}): Promise<{ observation: Observation } | { summary: SessionSummary }> {
        if (this.closed) return { summary: this.closed };
        if (this.busy) throw new Error('A step is already running');
        const video = this.current;
        if (!video) throw new Error('No video observed yet');
        this.busy = true;
        try {
            this.advancedOnItsOwn = false;
            const decidedAt = Date.now();
            const timed = timePlan({ ...plan, save: false }, this.personality, {
                judged: this.decisionMs.length, likes: this.likes, saves: 0,
            });
            this.decisionMs.push(decidedAt - video.observedAt);

            let liked = false;
            if (timed.likeAtMs !== undefined) {
                await sleep(decidedAt + timed.likeAtMs - Date.now());
                // Located right before the tap: Reels can move on by themselves.
                const like = await this.adapter.locateLike(this.context, video.reelId).catch(() => undefined);
                if (!like) console.log('[agent] like skipped: J\'aime not found confidently (or the Reel changed)');
                else if (!like.liked) { // a toggle: never undo an existing like
                    await tapCoordinate(this.context.driver, like.x, like.y, 'J\'aime', { radius: 4 });
                    liked = true;
                    this.likes += 1;
                }
            }
            const watched: WatchOutcome = plan.watch === 'full'
                ? await this.watchToEnd(decidedAt, timed.watchMs, video.reelId)
                : (await sleep(decidedAt + timed.watchMs - Date.now()), { by: 'timer' });

            if (video.isAd) this.ads += 1;
            if (plan.onNiche >= 0.5) this.onNiche += 1;
            if (plan.watch === 'skip') {
                this.skips += 1;
                this.skipScreenMs.push(Date.now() - video.arrivedAt);
            }
            // Only a Reel left playing a while can have moved on by itself; a skip has no time to.
            if (!this.advancedOnItsOwn && plan.watch !== 'skip' && video.reelId && this.adapter.currentReelId) {
                const now = await this.adapter.currentReelId(this.context).catch(() => undefined);
                if (now && now !== video.reelId) this.advancedOnItsOwn = true;
            }
            // Time is up: the last Reel is not swiped away; it stays on screen a
            // moment, like someone putting the phone down, then the app closes.
            const last = this.remainingMs <= 0;
            let swipe: SwipeRecord | null = null;
            if (last) await sleep(finalLingerMs());
            else if (this.advancedOnItsOwn) console.log('[agent] already on the next Reel; not swiping');
            else swipe = await this.swipe();
            const arrivedAt = Date.now();

            await appendFile(path.join(this.logDirectory, 'decisions.jsonl'), `${JSON.stringify({
                video: video.index, caption: video.caption, isAd: video.isAd, reelId: video.reelId, plan, timed, watched, liked,
                advancedOnItsOwn: this.advancedOnItsOwn, swipe, decisionMs: decidedAt - video.observedAt, screenMs: arrivedAt - video.arrivedAt,
                ...logExtra, ...(last ? { last: true } : {}),
            })}\n`).catch(() => undefined);

            if (last) return { summary: await this.stop('completed') };
            return { observation: await this.observe(arrivedAt) };
        } finally {
            this.busy = false;
        }
    }

    /** Keeps a `full` Reel on screen until it loops (progress), the app moves on, or the cap. */
    private async watchToEnd(decidedAt: number, timedWatchMs: number, reelId: string | undefined): Promise<WatchOutcome> {
        const capEnd = decidedAt + FULL_WATCH_CAP_MS[this.personality];
        const tracker = new ReelWatchTracker();
        let lastProgress: number | undefined;
        let misses = 0;
        while (Date.now() < capEnd) {
            const reading = await this.adapter.readProgress(this.context).catch(() => ({} as { progress?: number; reelId?: string }));
            if (reelId && reading.reelId && reading.reelId !== reelId) {
                this.advancedOnItsOwn = true;
                return { by: 'advanced', lastProgress: lastProgress ?? 0 };
            }
            if (reading.progress === undefined) {
                misses += 1;
                if (lastProgress === undefined && misses >= 2) break; // no bar on this Reel
            } else {
                lastProgress = reading.progress;
                const state = tracker.add({ atMs: Date.now(), progress: reading.progress });
                if (state.kind === 'completed' || reading.progress >= 0.98) {
                    await sleep(Math.min(300 + Math.random() * 1200, capEnd - Date.now()));
                    const videoMs = state.kind === 'completed' ? state.durationMs : undefined;
                    return { by: 'progress', completed: true, lastProgress: reading.progress, ...(videoMs ? { videoMs } : {}) };
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

    private async swipe(): Promise<SwipeRecord> {
        if (this.swipeStyle) return swipeRecord(this.swipeStyle, await performSwipe(this.context.driver, profileSwipe(this.swipeStyle)));
        return swipeRecord('fixed', await this.adapter.fixedSwipe(this.context));
    }

    async stop(reason: SessionSummary['reason'] = 'stopped'): Promise<SessionSummary> {
        if (this.closed) return this.closed;
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
            saves: 0,
            likeRate: rate(this.likes),
            saveRate: 0,
            ads: this.ads,
            medianDecisionMs: median(this.decisionMs),
            medianSkipScreenMs: median(this.skipScreenMs),
            elapsedMs: Date.now() - this.startedAt,
            logDirectory: this.logDirectory,
        };
        this.closed = summary;
        await writeFile(path.join(this.logDirectory, 'summary.json'), JSON.stringify(summary, null, 2)).catch(() => undefined);
        await this.context.driver.deleteSession().catch(() => undefined);
        return summary;
    }
}
