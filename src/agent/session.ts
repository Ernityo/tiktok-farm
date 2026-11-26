import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import sharp from 'sharp';
import { remote, type Browser } from 'webdriverio';

import {
    activeDevices, loadRegisteredDevices, resolveDeviceCoordinates, WdaRemoteControl, type HumanSwipe,
} from '@git-agni/phone-farm-core';
import type { RegisteredDevice } from '../devices/registry.js';
import { profileSwipe, resolveSwipeStyle, type SwipeProfile, type SwipeStyle } from '../devices/swipe-profiles.js';
import { ReelWatchTracker } from '../facebook/reels-progress.js';
import { appLaunchSettleMs, performSwipe, tapCoordinate } from '../tiktok/actions.js';
import { adFromWords, readCaptionWords } from '../tiktok/ad-detection.js';
import type { AgentApp } from './model.js';
import {
    autoSkipReason, engagementAllowance, finalLingerMs, FULL_WATCH_CAP_MS, sameCaption, sessionLengthMs, SHOP_POST, swipeRecord, timePlan,
    type AgentPlan, type SwipeRecord,
} from './plan.js';
import { PROFILES, type Personality } from '../tiktok/doomscroll-profile.js';
import { nicheForAccount, normalizeHandle, type Niche } from '../tiktok/niche.js';
import type { OcrWord } from '../tiktok/ocr.js';
import { coordinateProfile } from '../tiktok/runtime-settings.js';

// One agentic doomscroll session on one phone, for any short-video feed
// (TikTok, Facebook Reels, Instagram Reels): observe a video, take the
// model's plan, carry it out with humanized gestures, swipe, repeat. The
// app-specific parts (opening the feed, finding the like/save buttons,
// reading progress, spotting ads and cards, swipe coordinates) sit behind
// a small adapter per app.

export function envInteger(name: string, fallback: number, min: number, max: number): number {
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
/** Width of the JPEG sent to the model; smaller = fewer tokens. */
const IMAGE_WIDTH = envInteger('AGENT_IMAGE_WIDTH', 384, 160, 1200);
const IMAGE_QUALITY = envInteger('AGENT_IMAGE_QUALITY', 60, 20, 95);
const CAPTION_MAX_CHARS = 400;
const CAPTION_CROP_WIDTH = 640;
/** Extra swipes when the feed did not move on (same video as before). */
const MAX_SWIPE_RETRIES = 2;
/** Screens in a row without the feed's controls before stopping: we probably left the feed. */
const MAX_CARDS_IN_A_ROW = 6;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** What the session hands an adapter to act on the phone. */
export interface AppContext {
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
export interface VideoInspection {
    isAd: boolean;
    /** Skip without asking the model: 'card' (surely not a video), 'foreign' (translated caption), ... */
    autoSkip?: string;
    /** The feed's controls weren't found (the model still judges unless autoSkip says otherwise); many in a row stops the session. */
    noControls?: boolean;
    /** Tells one video from the next, when the app exposes it. */
    reelId?: string;
}

export interface TapTarget { x: number; y: number }

/** The like (and save) buttons right now, with whether they are already on. */
export interface EngagementTargets {
    like?: TapTarget & { liked: boolean };
    save?: TapTarget & { saved: boolean };
}

/** Area of the screen sent at full resolution as the caption image, as shares of the screen. */
export interface CaptionCrop { left: number; top: number; width: number; height: number }

export interface AgentAppAdapter {
    readonly app: AgentApp;
    readonly label: string;
    /** Niches are looked up under this plugin first, then under TikTok's. */
    readonly pluginId: string;
    readonly bundleId: string;
    /** Whether a video can be saved with one tap from the feed. */
    readonly canSave: boolean;
    readonly captionCrop: CaptionCrop;
    /** Caps how far taps land from the button centre, in points. */
    readonly tapRadius?: number;
    /** Throws when `account` can't be used on this device. */
    checkAccount?(device: RegisteredDevice, account: string): void;
    /** From a cold launch to the first video; throws when the feed can't be confirmed. */
    openFeed?(context: AppContext): Promise<void>;
    /** App-specific reading of a fresh video (OCR ads are already handled by the session). */
    inspect?(context: AppContext, screenshot: Buffer): Promise<VideoInspection>;
    /** A slower second ad check, run while the model thinks. */
    strictAd?(screenshot: Buffer): Promise<boolean>;
    /** Like/save buttons right now, or undefined when not confidently on screen. `reelId` = the video it must still be on. */
    locateControls(context: AppContext, reelId?: string): Promise<EngagementTargets | undefined>;
    /** Share of the video played, and the video now on screen (to notice the app moving on by itself). */
    readProgress(context: AppContext): Promise<{ progress?: number; reelId?: string }>;
    /** The video on screen now, when the app exposes it. */
    currentReelId?(context: AppContext): Promise<string | undefined>;
    /** Fixed upward swipe used when no thumb-side swipe style applies. */
    fixedSwipe(context: AppContext): Promise<HumanSwipe>;
    /** Swipe for ads, shop posts and retries, starting above their buttons. Defaults to the normal swipe. */
    adSwipe?(context: AppContext): Promise<HumanSwipe>;
}

export interface StartOptions {
    adapter: AgentAppAdapter;
    minutes: number;
    /** Caps likes/saves and sets watch lengths, like the programmatic profiles. */
    personality: Personality;
    udid?: string;
    /** Selects the niche (the app's own niche for this handle, else its TikTok one). No account switching. */
    account?: string;
    /** Overrides the account's saved niche (or stands in when no account is given). */
    niche?: Niche;
    /** Thumb-side swipe style; defaults to right-thumb. 'fixed' uses the app's fixed swipe. */
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
    /** Set when the session already knows to skip this video without asking the model (e.g. 'ad', 'shop', 'card', 'foreign'). */
    autoSkip?: string;
}

export interface SessionSummary {
    reason: 'completed' | 'stopped' | 'error';
    app: AgentApp;
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
    /** Time from a screenshot being returned to the plan arriving. */
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
    isAd: boolean;
    /** The stricter second ad pass, running while the model thinks. */
    strictAd: Promise<boolean>;
    reelId?: string;
    /** Extra swipes it took to get here because the previous swipe didn't move the feed on. */
    retrySwipes: SwipeRecord[];
}

type WatchOutcome =
    | { by: 'progress'; completed: boolean; lastProgress: number; videoMs?: number }
    | { by: 'advanced'; lastProgress: number }
    | { by: 'timer' };

export function median(values: readonly number[]): number | undefined {
    if (!values.length) return undefined;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Whether a swipe left the same video on screen: same id when the app
 * exposes one, else the same OCR'd caption.
 */
export function feedDidNotMove(
    before: { caption: string; reelId?: string | undefined },
    after: { caption: string; reelId?: string | undefined },
): boolean {
    if (before.reelId && after.reelId) return before.reelId === after.reelId;
    return sameCaption(before.caption, after.caption);
}

export function resolveDevice(devices: readonly RegisteredDevice[], udid: string | undefined): RegisteredDevice {
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

export class AgentSession {
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
    private cardsInARow = 0;
    /** The app moved to the next video on its own: don't swipe past it. */
    private advancedOnItsOwn = false;
    private readonly decisionMs: number[] = [];
    private readonly skipScreenMs: number[] = [];
    private readonly startedAt = Date.now();

    private constructor(
        private readonly adapter: AgentAppAdapter,
        private readonly context: AppContext,
        private readonly deadline: number,
        private readonly logDirectory: string,
        readonly account: string | undefined,
        readonly niche: Niche,
        readonly personality: Personality,
        private readonly swipeStyle: SwipeProfile | undefined,
    ) {}

    get app(): AgentApp {
        return this.adapter.app;
    }

    /** Unlocks the phone, opens the app's feed (already on the account), and observes the first video. */
    static async start(options: StartOptions): Promise<{ session: AgentSession; observation: Observation }> {
        const { adapter } = options;
        const device = resolveDevice(await loadRegisteredDevices(), options.udid);
        const account = options.account ? normalizeHandle(options.account) : undefined;
        if (account) adapter.checkAccount?.(device, account);
        const niche = options.niche
            ?? (account ? nicheForAccount(device, account, adapter.pluginId) ?? nicheForAccount(device, account) : undefined);
        if (!niche) {
            throw new Error(account
                ? `${account} has no niche on this device: pass a niche, or save one for it (device page → Niches)`
                : 'Pass a niche, or an account that has one');
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
                // The model thinks between calls; keep the session alive.
                'appium:newCommandTimeout': 300,
                // Feeds autoplay video, so the app never becomes idle.
                'appium:waitForIdleTimeout': 0,
                'appium:webDriverAgentUrl': wdaUrl,
                'appium:wdaRemotePort': device.wdaRemotePort ?? Number(process.env.WDA_REMOTE_PORT ?? 8100),
            } as WebdriverIO.Capabilities,
        });
        try {
            await driver.updateSettings({ defaultActiveApplication: adapter.bundleId });
            await driver.pause(appLaunchSettleMs()); // let a launch ad settle
            const { scale } = await remoteControl.getScreenInfo(device.udid);
            const window = await driver.getWindowRect();
            const context: AppContext = {
                driver, remoteControl, device, coordinates, scale, window,
                screenshot: () => remoteControl.getScreenshot(device.udid),
            };
            await adapter.openFeed?.(context);

            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const logDirectory = path.resolve('.agent-runs', `${stamp}-${adapter.app}-${(account ?? 'current').replace(/^@/, '')}`);
            await mkdir(logDirectory, { recursive: true });
            await writeFile(path.join(logDirectory, 'session.json'), JSON.stringify({
                app: adapter.app, udid: device.udid, account, niche, personality: options.personality, minutes: options.minutes,
                startedAt: new Date().toISOString(),
            }, null, 2));
            const session = new AgentSession(
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
        const crop = this.adapter.captionCrop;
        const { width = 0, height = 0 } = await sharp(screenshot).metadata();
        return sharp(screenshot)
            .extract({
                left: Math.round(width * crop.left),
                top: Math.round(height * crop.top),
                width: Math.round(width * crop.width),
                height: Math.round(height * crop.height),
            })
            .resize({ width: CAPTION_CROP_WIDTH, withoutEnlargement: true })
            .jpeg({ quality: 70 })
            .toBuffer();
    }

    private async capture() {
        await sleep(SETTLE_MS);
        const screenshot = await this.context.screenshot();
        const [words, image, captionImage, inspection] = await Promise.all([
            readCaptionWords(screenshot).catch((): OcrWord[] => []),
            sharp(screenshot).resize({ width: IMAGE_WIDTH }).jpeg({ quality: IMAGE_QUALITY }).toBuffer(),
            this.captionCrop(screenshot),
            this.adapter.inspect?.(this.context, screenshot) ?? Promise.resolve<VideoInspection>({ isAd: false }),
        ]);
        const caption = words.map((word) => word.text).join(' ').slice(0, CAPTION_MAX_CHARS);
        return { screenshot, words, image, captionImage, inspection, caption };
    }

    /** `previous` is the video swiped away, to notice a swipe that didn't move the feed on. */
    private async observe(arrivedAt: number, previous?: { caption: string; reelId?: string }): Promise<Observation> {
        let { screenshot, words, image, captionImage, inspection, caption } = await this.capture();
        const retrySwipes: SwipeRecord[] = [];
        // A swipe can fail to move the feed on (seen on TikTok Shop posts):
        // the same video is still there, so swipe again from higher up.
        for (let retry = 1; retry <= MAX_SWIPE_RETRIES && previous && feedDidNotMove(previous, { caption, reelId: inspection.reelId }); retry++) {
            console.log(`[agent] swipe did not move the feed on; swiping again (${retry}/${MAX_SWIPE_RETRIES})`);
            retrySwipes.push(await this.swipe(true));
            arrivedAt = Date.now();
            ({ screenshot, words, image, captionImage, inspection, caption } = await this.capture());
        }
        const isAd = inspection.isAd || adFromWords(words).isAd;
        if (inspection.noControls || inspection.autoSkip === 'card') {
            this.cardsInARow += 1;
            if (this.cardsInARow >= MAX_CARDS_IN_A_ROW) {
                throw new Error(`No video on ${this.cardsInARow} screens in a row; ${this.adapter.label} is probably showing another screen`);
            }
        } else {
            this.cardsInARow = 0;
        }
        this.videos += 1;
        this.current = {
            index: this.videos, arrivedAt, observedAt: Date.now(), caption, isAd, retrySwipes,
            strictAd: isAd || !this.adapter.strictAd ? Promise.resolve(isAd) : this.adapter.strictAd(screenshot).catch(() => false),
            ...(inspection.reelId ? { reelId: inspection.reelId } : {}),
        };
        const stem = path.join(this.logDirectory, String(this.videos).padStart(4, '0'));
        await Promise.all([
            writeFile(`${stem}.jpg`, image).catch(() => undefined),
            writeFile(`${stem}-caption.jpg`, captionImage).catch(() => undefined),
        ]);
        const judgedIncludingThis = this.decisionMs.length + 1;
        const profile = PROFILES[this.personality];
        const autoSkip = autoSkipReason({ isAd, caption }) ?? inspection.autoSkip;
        return {
            video: this.videos, image, captionImage, caption, isAd, remainingMs: this.remainingMs,
            engagement: {
                likes: this.likes, likesAllowed: engagementAllowance(judgedIncludingThis, profile.likeChance),
                saves: this.saves, savesAllowed: this.adapter.canSave ? engagementAllowance(judgedIncludingThis, profile.saveChance) : 0,
            },
            ...(autoSkip ? { autoSkip } : {}),
        };
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
            this.advancedOnItsOwn = false;
            const decidedAt = Date.now();
            const canSave = this.adapter.canSave;
            const timed = timePlan(canSave ? plan : { ...plan, save: false }, this.personality, {
                judged: this.decisionMs.length, likes: this.likes, saves: this.saves,
            });
            this.decisionMs.push(decidedAt - video.observedAt);

            const actions: Array<{ at: number; kind: 'like' | 'save' }> = [];
            if (timed.likeAtMs !== undefined) actions.push({ at: timed.likeAtMs, kind: 'like' });
            if (timed.saveAtMs !== undefined) actions.push({ at: timed.saveAtMs, kind: 'save' });
            actions.sort((a, b) => a.at - b.at);
            let liked = false;
            let saved = false;
            for (const action of actions) {
                await sleep(decidedAt + action.at - Date.now());
                // Located right before the tap: the rail moves, and Reels can move on by themselves.
                const controls = await this.adapter.locateControls(this.context, video.reelId).catch((error: unknown) => {
                    console.log(`[agent] control detection failed: ${error instanceof Error ? error.message : String(error)}`);
                    return undefined;
                });
                const radius = this.adapter.tapRadius !== undefined ? { radius: this.adapter.tapRadius } : {};
                // Heart and bookmark are toggles: never undo an existing like/save.
                if (action.kind === 'like') {
                    if (!controls?.like) console.log('[agent] like skipped: button not found confidently (or the video changed)');
                    else if (!controls.like.liked) {
                        await tapCoordinate(this.context.driver, controls.like.x, controls.like.y, 'Like', radius);
                        liked = true;
                        this.likes += 1;
                    }
                } else if (!controls?.save) {
                    console.log('[agent] save skipped: button not found confidently');
                } else if (!controls.save.saved) {
                    await tapCoordinate(this.context.driver, controls.save.x, controls.save.y, 'Save', radius);
                    saved = true;
                    this.saves += 1;
                }
            }
            const watched: WatchOutcome = plan.watch === 'full'
                ? await this.watchToEnd(decidedAt, timed.watchMs, video.reelId)
                : (await sleep(decidedAt + timed.watchMs - Date.now()), { by: 'timer' });

            const isAd = await video.strictAd;
            if (isAd) this.ads += 1;
            if (plan.onNiche >= 0.5) this.onNiche += 1;
            if (plan.watch === 'skip') {
                this.skips += 1;
                this.skipScreenMs.push(Date.now() - video.arrivedAt);
            }
            // Only a video left playing a while can have moved on by itself; a skip has no time to.
            if (!this.advancedOnItsOwn && plan.watch !== 'skip' && video.reelId && this.adapter.currentReelId) {
                const now = await this.adapter.currentReelId(this.context).catch(() => undefined);
                if (now && now !== video.reelId) this.advancedOnItsOwn = true;
            }
            // Time is up: the last video is not swiped away; it stays on screen a
            // moment, like someone putting the phone down, then the app closes.
            const last = this.remainingMs <= 0;
            let swipe: SwipeRecord | null = null;
            if (last) await sleep(finalLingerMs());
            else if (this.advancedOnItsOwn) console.log('[agent] already on the next video; not swiping');
            else swipe = await this.swipe(isAd || SHOP_POST.test(video.caption));
            const arrivedAt = Date.now();

            await appendFile(path.join(this.logDirectory, 'decisions.jsonl'), `${JSON.stringify({
                video: video.index, caption: video.caption, isAd, ...(video.reelId ? { reelId: video.reelId } : {}),
                plan, timed, watched, liked, ...(canSave ? { saved } : {}),
                ...(this.advancedOnItsOwn ? { advancedOnItsOwn: true } : {}),
                decisionMs: decidedAt - video.observedAt, screenMs: arrivedAt - video.arrivedAt, swipe,
                ...(video.retrySwipes.length ? { retrySwipes: video.retrySwipes } : {}), ...logExtra,
                ...(last ? { last: true } : {}),
            })}\n`).catch(() => undefined);

            if (last) return { summary: await this.stop('completed') };
            // When we didn't swipe, the app moved on itself: no "same video" check.
            return { observation: await this.observe(arrivedAt, swipe ? video : undefined) };
        } finally {
            this.busy = false;
        }
    }

    /**
     * Keeps a `full` video on screen until it has played to the end (the
     * progress bar loops back to the start), the app moves on, or the cap.
     * Videos without a bar fall back to the timed watch.
     */
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
                // Two misses before any reading: this video has no bar.
                if (lastProgress === undefined && misses >= 2) break;
            } else {
                lastProgress = reading.progress;
                const state = tracker.add({ atMs: Date.now(), progress: reading.progress });
                if (state.kind === 'completed' || reading.progress >= 0.98) {
                    // Swipe a moment after the loop starts, like a person would.
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

    /** `careful`: an ad, shop post or retry, where the app's ad swipe (if any) starts above the buttons. */
    private async swipe(careful = false): Promise<SwipeRecord> {
        if (careful && this.adapter.adSwipe) return swipeRecord('ad', await this.adapter.adSwipe(this.context));
        if (this.swipeStyle) return swipeRecord(this.swipeStyle, await performSwipe(this.context.driver, profileSwipe(this.swipeStyle)));
        return swipeRecord('fixed', await this.adapter.fixedSwipe(this.context));
    }

    /** Ends the session (idempotent) and returns its summary. */
    async stop(reason: SessionSummary['reason'] = 'stopped'): Promise<SessionSummary> {
        if (this.closed) return this.closed;
        // Videos the model decided on; the last one observed may not have been.
        const judged = this.decisionMs.length;
        const rate = (count: number) => (judged ? Math.round((count / judged) * 100) / 100 : 0);
        const summary: SessionSummary = {
            reason,
            app: this.adapter.app,
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
        await this.context.driver.deleteSession().catch(() => undefined);
        return summary;
    }
}
