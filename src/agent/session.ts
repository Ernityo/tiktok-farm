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
import { AppStuckError, commentAllowance, commentChance, commentOpen, commentWarmupMs } from './comment.js';
import type { AgentApp, ScrollGoal } from './model.js';
import {
    autoSkipReason, engagementAllowance, finalLingerMs, FULL_WATCH_CAP_MS, MIN_ACTION_GAP_MS, sameCaption, sessionLengthMs, SHOP_POST, swipeRecord, timePlan,
    type AgentPlan, type SwipeRecord,
} from './plan.js';
import { PROFILES, type Personality } from '../tiktok/doomscroll-profile.js';
import { nicheForAccount, normalizeHandle, type Niche } from '../tiktok/niche.js';
import type { OcrWord } from '../tiktok/ocr.js';
import { coordinateProfile } from '../tiktok/runtime-settings.js';
import { followAllowance } from '../tiktok/warmup.js';
import { writeRunReport } from './report.js';
import { earlyDecideEnabled, type SessionSource, type Span, type VideoSpans } from './trace.js';

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

/**
 * Wait after a swipe before the screenshot. 0: on Facebook the feed had
 * already stopped in the first screenshot after the finger lifted (5 swipes
 * measured), and a screenshot takes 250-500 ms anyway. Raise it with
 * AGENT_SETTLE_MS if a screenshot ever catches the feed mid-scroll.
 */
const SETTLE_MS = envInteger('AGENT_SETTLE_MS', 0, 0, 5000);
/** Width of the JPEG sent to the model; smaller = fewer tokens. */
const IMAGE_WIDTH = envInteger('AGENT_IMAGE_WIDTH', 384, 160, 1200);
const IMAGE_QUALITY = envInteger('AGENT_IMAGE_QUALITY', 60, 20, 95);
/**
 * Where screenshots come from. 'mjpeg' (default): one frame off WDA's MJPEG
 * server, opened per screenshot and closed right after (full-res JPEG, no
 * re-encode; ~40 ms vs ~390 ms on Facebook); falls back to /screenshot if the
 * stream fails. 'screenshot': WDA /screenshot (a full-res PNG re-encoded on
 * the phone, then base64).
 */
const FRAME_SOURCE = process.env.AGENT_FRAME_SOURCE === 'screenshot' ? 'screenshot' : 'mjpeg';
/** JPEG quality of MJPEG frames; the OCR and pixel checks read them at full resolution. */
const FRAME_QUALITY = envInteger('AGENT_FRAME_QUALITY', 80, 30, 100);
/** WDA only captures while a client is connected; a high rate just shortens the wait for the next tick. */
const FRAME_RATE = 30;
const FRAME_TIMEOUT_MS = 2000;
/**
 * AGENT_FRAME_COMPARE=1 (with MJPEG frames): also take a /screenshot right
 * after each video's frame and read it the same way, so the runner can judge
 * both (src/agent/frame-compare.ts). Slows each video by the extra grab.
 */
const FRAME_COMPARE = process.env.AGENT_FRAME_COMPARE === '1' && FRAME_SOURCE === 'mjpeg';
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
    /** WDA's MJPEG settings before connectApp changed them; disconnectApp puts them back. */
    mjpegRestore?: Record<string, unknown>;
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
    /** Shortest recorded-style swipe, in points, for apps that ignore short flicks. */
    readonly minSwipeTravel?: number;
    /** Throws when `account` can't be used on this device. */
    checkAccount?(device: RegisteredDevice, account: string): void;
    /**
     * From the feed: checks which account the app is on, switches to `account`
     * if needed, and comes back to the feed. Throws when it can't be confirmed.
     * Apps without it trust that the phone is already on the account.
     */
    ensureAccount?(context: AppContext, account: string): Promise<AccountCheck>;
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
    /**
     * Leaves `text` (sanitized, one line) as a comment on the video on screen and
     * comes back to the feed. Throws when it couldn't comment; throws
     * AppStuckError when the feed can't be brought back. Apps without it never comment.
     */
    comment?(context: AppContext, text: string): Promise<{ verified: boolean; durationMs?: number; steps?: Record<string, number> }>;
    /**
     * Follows the creator of the video on screen and comes back to it in the
     * feed. 'plus': the small + under their avatar. 'profile': open their
     * profile, Follow, watch one or two of their videos, back. Throws when it
     * couldn't follow; throws AppStuckError when the feed can't be brought back.
     * Apps without it never follow.
     */
    follow?(context: AppContext, how: FollowHow): Promise<{ verified: boolean; profileVideos?: number; durationMs: number }>;
    /** The ways `follow` can follow; defaults to both. */
    readonly followModes?: readonly FollowHow[];
    /**
     * From the feed: searches `query` and opens the first video result in the
     * vertical player, ready to be scrolled like the feed. Throws when it
     * can't (AppStuckError when the feed can't be brought back either).
     */
    openSearch?(context: AppContext, query: string): Promise<void>;
    /** From a search result video: back to the main feed. Throws AppStuckError when it can't. */
    leaveSearch?(context: AppContext): Promise<void>;
}

export type FollowHow = 'plus' | 'profile';

/** Share of follows done from the profile (Follow there, watch 1-2 videos) rather than the + on the avatar. */
const PROFILE_FOLLOW_CHANCE = 0.4;

/** A detour through search in the middle of a session (warm-up, niche phase). */
export interface SearchDetour {
    query: string;
    /** Scroll the main feed this long before searching. */
    afterMs: number;
    /** Judged result videos before going back to the main feed. */
    videos: number;
}

export type FeedPlace = 'feed' | 'search';

export interface AccountCheck {
    /** The account the app was on. */
    from: string;
    switched: boolean;
    durationMs: number;
}

export interface StartOptions {
    adapter: AgentAppAdapter;
    minutes: number;
    /** Caps likes/saves and sets watch lengths, like the programmatic profiles. */
    personality: Personality;
    udid?: string;
    /**
     * Selects the niche (the app's own niche for this handle, else its TikTok
     * one). On apps that can (TikTok), the account is also checked after the
     * first video or two, and switched to if the phone is on another one.
     */
    account?: string;
    /** Overrides the account's saved niche (or stands in when no account is given). */
    niche?: Niche;
    /** Thumb-side swipe style; defaults to right-thumb. 'fixed' uses the app's fixed swipe. */
    swipeStyle?: SwipeStyle;
    /** What the session teaches the feed (kept in the logs); the prompt is the caller's. Defaults to the niche. */
    goal?: ScrollGoal;
    /** Creators to follow over the session (paced); 0 or unset = never follow. */
    follows?: number;
    /** Never comment, even on apps that can. */
    noComments?: boolean;
    /** Search once, part-way through the session. */
    search?: SearchDetour;
    /** Extra fields written to session.json and summary.json (e.g. the warm-up day and phase). */
    meta?: Record<string, unknown>;
    /** Who started the session; written to session.json and summary.json. */
    source?: SessionSource;
}

/** What the caller knows about how this video's plan was made (see `step`). */
export interface StepTrace {
    /** When the model call that decided this video started and finished. */
    model?: { start: number; end: number };
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
    /** Likes/saves/comments done so far, and how many the rate allows if this video gets one. */
    engagement: {
        likes: number; likesAllowed: number; saves: number; savesAllowed: number;
        comments?: number; commentsAllowed?: number; follows?: number; followsAllowed?: number;
    };
    /** Main feed or search results. */
    place: FeedPlace;
    /** Set when the session already knows to skip this video without asking the model (e.g. 'ad', 'shop', 'card', 'foreign'). */
    autoSkip?: string;
    /** AGENT_FRAME_COMPARE: the same video read from both frame sources. */
    compare?: FrameComparison;
}

/** What the code reads off one frame, for AGENT_FRAME_COMPARE. */
export interface FrameReading {
    image: Buffer;
    captionImage: Buffer;
    caption: string;
    isAd: boolean;
    noControls: boolean;
    autoSkip?: string;
    /** Size of the full frame, in KB. */
    kb: number;
}

export interface FrameComparison {
    /** Where the run writes compare.jsonl. */
    directory: string;
    /** The MJPEG frame the session acts on. */
    mjpeg: FrameReading;
    /** /screenshot (PNG), taken right after it. */
    png: FrameReading & { grabMs: number };
}

/** A fresh frame with what the model needs, before the OCR and the code-side checks (see `onFrame`). */
export type Frame = Pick<Observation, 'video' | 'image' | 'captionImage' | 'engagement'>;

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
    comments: number;
    follows: number;
    /** Judged videos on the main feed (For You), and the share of them on-niche: the warm-up's convergence measure. */
    feedVideos: number;
    feedOnNicheShare: number;
    /** The search detour, when one was planned. */
    search?: { query: string; videos: number; onNiche: number; error?: string };
    goal: ScrollGoal;
    /** Share of judged videos liked / saved. */
    likeRate: number;
    saveRate: number;
    ads: number;
    /** Time from the observation being ready to the plan arriving (all videos, auto-skips included). */
    medianDecisionMs?: number;
    /** Time from the swipe landing to the plan arriving, for videos the model judged. */
    medianTimeToDecisionMs?: number;
    /** Screen time of skipped videos, from the swipe landing to the next swipe. */
    medianSkipScreenMs?: number;
    elapsedMs: number;
    logDirectory: string;
    /** The account check after the first videos, when the app has one. */
    accountCheck?: AccountCheck;
    source?: SessionSource;
    meta?: Record<string, unknown>;
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
    place: FeedPlace;
    /** Extra swipes it took to get here because the previous swipe didn't move the feed on. */
    retrySwipes: SwipeRecord[];
    /** Timings of the capture that observed it (the last one, after a retried swipe). */
    marks: CaptureMarks;
}

/** When each part of a capture finished (Date.now()). */
interface CaptureMarks {
    startedAt: number;
    settledAt: number;
    shotAt: number;
    imagesAt: number;
    ocrAt: number;
    inspectAt: number;
}

type WatchOutcome =
    | { by: 'progress'; completed: boolean; lastProgress: number; videoMs?: number }
    | { by: 'advanced'; lastProgress: number }
    | { by: 'timer' }
    | { by: 'commented' };

export function median(values: readonly number[]): number | undefined {
    if (!values.length) return undefined;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Whether a swipe left the same video on screen: the same OCR'd caption.
 * A different id proves the feed moved, but the same id doesn't prove it
 * didn't: Instagram's id names the creator ("Reel de x."), not the Reel.
 * Two parts of a series with near-identical captions still look the same:
 * that costs one extra swipe.
 */
export function feedDidNotMove(
    before: { caption: string; reelId?: string | undefined },
    after: { caption: string; reelId?: string | undefined },
): boolean {
    if (before.reelId && after.reelId && before.reelId !== after.reelId) return false;
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

/** Screenshots off the MJPEG stream, falling back to /screenshot (and saying so once) when it fails. */
function streamScreenshot(remoteControl: WdaRemoteControl, udid: string): () => Promise<Buffer> {
    let warned = false;
    return async () => {
        try {
            return await remoteControl.getStreamFrame(udid, FRAME_TIMEOUT_MS);
        } catch (error) {
            if (!warned) {
                warned = true;
                console.warn(`[agent] MJPEG frame failed, using /screenshot: ${error instanceof Error ? error.message : String(error)}`);
            }
            return remoteControl.getScreenshot(udid);
        }
    };
}

/**
 * Unlocks the phone and opens an Appium session on the app. `launch`
 * relaunches it from cold (a doomscroll); otherwise it attaches to the app
 * as it is on screen (e.g. to comment on the Reel already showing).
 */
export async function connectApp(device: RegisteredDevice, bundleId: string, { launch }: { launch: boolean }): Promise<AppContext> {
    const coordinates = resolveDeviceCoordinates(coordinateProfile(device), device.coordinates);
    const wdaUrl = process.env.WDA_URL ?? `http://127.0.0.1:${device.wdaLocalPort ?? Number(process.env.WDA_LOCAL_PORT ?? 8100)}`;
    const remoteControl = new WdaRemoteControl({
        deviceUdid: device.udid,
        wdaUrl,
        mjpegUrl: process.env.MJPEG_URL ?? `http://127.0.0.1:${device.mjpegLocalPort ?? Number(process.env.MJPEG_LOCAL_PORT ?? 9100)}`,
        passcode: device.passcode ?? process.env.IOS_PASSCODE,
        passcodeKeypadLayout: coordinates.passcodeKeypad,
    });
    console.log(`[agent] unlocking ${device.udid}`);
    await remoteControl.unlock(device.udid);
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
            'appium:forceAppLaunch': launch,
            'appium:shouldTerminateApp': launch,
            // The model thinks between calls; keep the session alive.
            'appium:newCommandTimeout': 300,
            // Feeds autoplay video, so the app never becomes idle.
            'appium:waitForIdleTimeout': 0,
            'appium:webDriverAgentUrl': wdaUrl,
            'appium:wdaRemotePort': device.wdaRemotePort ?? Number(process.env.WDA_REMOTE_PORT ?? 8100),
        } as WebdriverIO.Capabilities,
    });
    let mjpegRestore: Record<string, unknown> | undefined;
    try {
        if (FRAME_SOURCE === 'mjpeg') mjpegRestore = await currentMjpegSettings(driver);
        await driver.updateSettings({
            defaultActiveApplication: bundleId,
            // Full resolution, as /screenshot: the caption crop, OCR and pixel checks use the same coordinates.
            ...(FRAME_SOURCE === 'mjpeg'
                ? { mjpegScalingFactor: 100, mjpegServerScreenshotQuality: FRAME_QUALITY, mjpegServerFramerate: FRAME_RATE }
                : {}),
        });
        if (launch) await driver.pause(appLaunchSettleMs()); // let a launch ad settle
        // From WDA, not driver.getWindowRect(): that looks up the app element,
        // which hangs on TikTok's constantly updating feed.
        const { scale, screenSize } = await remoteControl.getScreenInfo(device.udid);
        return {
            driver, remoteControl, device, coordinates, scale,
            window: { width: screenSize.width, height: screenSize.height },
            screenshot: FRAME_SOURCE === 'mjpeg' ? streamScreenshot(remoteControl, device.udid) : () => remoteControl.getScreenshot(device.udid),
            ...(mjpegRestore ? { mjpegRestore } : {}),
        };
    } catch (error) {
        await disconnectApp({ driver, mjpegRestore });
        throw error;
    }
}

/** WDA's MJPEG settings that connectApp changes. */
const MJPEG_SETTING_KEYS = ['mjpegScalingFactor', 'mjpegServerScreenshotQuality', 'mjpegServerFramerate'] as const;

/** The MJPEG settings WDA has now, to put back on disconnect; undefined if they can't be read. */
async function currentMjpegSettings(driver: Browser): Promise<Record<string, unknown> | undefined> {
    try {
        const settings = await driver.getSettings() as Record<string, unknown>;
        const kept = Object.fromEntries(MJPEG_SETTING_KEYS.filter((key) => settings[key] !== undefined).map((key) => [key, settings[key]]));
        return Object.keys(kept).length ? kept : undefined;
    } catch (error) {
        console.warn(`[agent] could not read WDA's MJPEG settings; they will stay full-res after the run: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
    }
}

/**
 * Ends the Appium session. The MJPEG settings are process-wide in WDA, so the
 * ones connectApp found are put back first: otherwise the dashboard's live view
 * would keep streaming full-res frames at 30 fps after the run.
 */
export async function disconnectApp(context: Pick<AppContext, 'driver' | 'mjpegRestore'>): Promise<void> {
    if (context.mjpegRestore) {
        await context.driver.updateSettings(context.mjpegRestore).catch((error: unknown) => {
            console.warn(`[agent] could not restore WDA's MJPEG settings: ${error instanceof Error ? error.message : String(error)}`);
        });
    }
    await context.driver.deleteSession().catch(() => undefined);
}

export class AgentSession {
    private current: CurrentVideo | undefined;
    private busy = false;
    private frameListener: ((frame: Frame) => void) | undefined;
    private closed: SessionSummary | undefined;
    /** Videos observed so far (numbers the screenshots). */
    private videos = 0;
    private onNiche = 0;
    private skips = 0;
    private likes = 0;
    private saves = 0;
    private comments = 0;
    private follows = 0;
    private feedVideos = 0;
    private feedOnNiche = 0;
    private place: FeedPlace = 'feed';
    private searchState: 'pending' | 'in' | 'done' | undefined;
    private searchVideos = 0;
    private searchOnNiche = 0;
    private searchError: string | undefined;
    /** Videos judged when the last comment was left. */
    private lastCommentAt: number | undefined;
    private ads = 0;
    private cardsInARow = 0;
    /** The app moved to the next video on its own: don't swipe past it. */
    private advancedOnItsOwn = false;
    /**
     * Video after which the account is checked (1 or 2), until it has been.
     * Until then nothing is liked, saved or commented: it may be the wrong account.
     */
    private accountCheckAfter: number | undefined;
    private accountCheck: AccountCheck | undefined;
    private readonly decisionMs: number[] = [];
    private readonly timeToDecisionMs: number[] = [];
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
        private readonly extras: Pick<StartOptions, 'goal' | 'follows' | 'noComments' | 'search' | 'meta' | 'source'> & { lengthMs: number },
    ) {
        if (account && adapter.ensureAccount) this.accountCheckAfter = 1 + Math.floor(Math.random() * 2);
        if (extras.search) this.searchState = 'pending';
    }

    get goal(): ScrollGoal {
        return this.extras.goal ?? 'niche';
    }

    /** Follows allowed by now, paced over the session; 0 when the session doesn't follow. */
    private followsAllowed(): number {
        if (!this.adapter.follow || !this.extras.follows) return 0;
        return followAllowance(this.extras.follows, (Date.now() - this.startedAt) / this.extras.lengthMs);
    }

    private canComment(): boolean {
        return Boolean(this.adapter.comment) && !this.extras.noComments;
    }

    get app(): AgentApp {
        return this.adapter.app;
    }

    /** Unlocks the phone, opens the app's feed, and observes the first video (the account is checked a video or two later). */
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

        const swipeStyle = resolveSwipeStyle(options.swipeStyle, coordinateProfile(device));
        console.log(`[agent] opening ${adapter.label}`);
        const context = await connectApp(device, adapter.bundleId, { launch: true });
        try {
            await adapter.openFeed?.(context);

            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const logDirectory = path.resolve('.agent-runs', `${stamp}-${adapter.app}-${(account ?? 'current').replace(/^@/, '')}`);
            await mkdir(logDirectory, { recursive: true });
            const lengthMs = sessionLengthMs(options.minutes);
            await writeFile(path.join(logDirectory, 'session.json'), JSON.stringify({
                app: adapter.app, udid: device.udid, account, niche, personality: options.personality, minutes: options.minutes,
                frames: FRAME_SOURCE === 'mjpeg' ? { source: FRAME_SOURCE, quality: FRAME_QUALITY, ...(FRAME_COMPARE ? { compare: true } : {}) } : { source: FRAME_SOURCE },
                goal: options.goal ?? 'niche',
                ...(options.follows ? { follows: options.follows } : {}),
                ...(options.search ? { search: options.search } : {}),
                ...(options.meta ? { meta: options.meta } : {}),
                ...(options.source ? { source: options.source } : {}),
                // The latency settings, to compare runs (the MCP path has no model call of its own).
                settings: { settleMs: SETTLE_MS, ...(options.source === 'mcp' ? {} : { earlyDecide: earlyDecideEnabled() }) },
                startedAt: new Date().toISOString(),
            }, null, 2));
            const session = new AgentSession(
                adapter, context, Date.now() + lengthMs, logDirectory, account, niche, options.personality, swipeStyle,
                {
                    lengthMs, goal: options.goal, follows: options.follows, noComments: options.noComments, search: options.search,
                    meta: options.meta, source: options.source,
                },
            );
            return { session, observation: await session.observe(Date.now()) };
        } catch (error) {
            await disconnectApp(context);
            throw error;
        }
    }

    /** The session has scrolled long enough for a comment. */
    private commentsWarm(): boolean {
        return Date.now() - this.startedAt >= commentWarmupMs();
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

    /**
     * Called with each fresh frame as soon as the model's images are ready,
     * before the caption OCR and the adapter's checks: the runner starts the
     * model call here, alongside them. Several frames can come for one video
     * (a swipe that didn't move the feed is retried); the last one is observed.
     */
    onFrame(listener: ((frame: Frame) => void) | undefined): void {
        this.frameListener = listener;
    }

    private async capture() {
        const startedAt = Date.now();
        await sleep(SETTLE_MS);
        const settledAt = Date.now();
        const screenshot = await this.context.screenshot();
        const shotAt = Date.now();
        // The model's images first, and the model call with them: the OCR and
        // the adapter's checks run long synchronous pixel loops that would
        // hold these back (the resize itself takes ~20 ms).
        const [image, captionImage] = await Promise.all([
            sharp(screenshot).resize({ width: IMAGE_WIDTH }).jpeg({ quality: IMAGE_QUALITY }).toBuffer(),
            this.captionCrop(screenshot),
        ]);
        const imagesAt = Date.now();
        this.frameListener?.({ video: this.videos + 1, image, captionImage, engagement: this.engagementFor(this.decisionMs.length + 1) });
        let ocrAt = imagesAt;
        let inspectAt = imagesAt;
        const words = readCaptionWords(screenshot).catch((): OcrWord[] => []).finally(() => { ocrAt = Date.now(); });
        const inspection = (this.adapter.inspect?.(this.context, screenshot) ?? Promise.resolve<VideoInspection>({ isAd: false }))
            .finally(() => { inspectAt = Date.now(); });
        // Still rejects into the Promise.all below; this only stops an early failure counting as unhandled.
        inspection.catch(() => undefined);
        const [captionWords, inspected] = await Promise.all([words, inspection]);
        const caption = captionWords.map((word) => word.text).join(' ').slice(0, CAPTION_MAX_CHARS);
        const marks: CaptureMarks = { startedAt, settledAt, shotAt, imagesAt, ocrAt, inspectAt };
        return { screenshot, words: captionWords, image, captionImage, inspection: inspected, caption, marks };
    }

    /** AGENT_FRAME_COMPARE: a /screenshot of the same video, read exactly like the MJPEG frame. */
    private async compareFrame(stem: string, mjpeg: FrameReading): Promise<FrameComparison> {
        const start = Date.now();
        const screenshot = await this.context.remoteControl.getScreenshot(this.context.device.udid);
        const grabMs = Date.now() - start;
        const [image, captionImage, words, inspection] = await Promise.all([
            sharp(screenshot).resize({ width: IMAGE_WIDTH }).jpeg({ quality: IMAGE_QUALITY }).toBuffer(),
            this.captionCrop(screenshot),
            readCaptionWords(screenshot).catch((): OcrWord[] => []),
            this.adapter.inspect?.(this.context, screenshot) ?? Promise.resolve<VideoInspection>({ isAd: false }),
        ]);
        const caption = words.map((word) => word.text).join(' ').slice(0, CAPTION_MAX_CHARS);
        const isAd = inspection.isAd || adFromWords(words).isAd;
        const autoSkip = autoSkipReason({ isAd, caption }) ?? inspection.autoSkip;
        await writeFile(`${stem}-png.jpg`, image).catch(() => undefined);
        return {
            directory: this.logDirectory,
            mjpeg,
            png: {
                image, captionImage, caption, isAd, noControls: Boolean(inspection.noControls), kb: Math.round(screenshot.length / 1024), grabMs,
                ...(autoSkip ? { autoSkip } : {}),
            },
        };
    }

    /** Likes/saves/comments/follows done, and what the rate allows if this video gets one. */
    private engagementFor(judgedIncludingThis: number): Observation['engagement'] {
        const profile = PROFILES[this.personality];
        const followsAllowed = this.followsAllowed();
        return {
            likes: this.likes, likesAllowed: engagementAllowance(judgedIncludingThis, profile.likeChance),
            saves: this.saves, savesAllowed: this.adapter.canSave ? engagementAllowance(judgedIncludingThis, profile.saveChance) : 0,
            ...(followsAllowed > 0 ? { follows: this.follows, followsAllowed } : {}),
            ...(this.canComment()
                // The model only sees a comments line while one may be left now.
                ? {
                    comments: this.comments,
                    commentsAllowed: this.commentsWarm() && commentOpen(judgedIncludingThis, this.comments, this.lastCommentAt, commentChance(this.personality))
                        ? commentAllowance(judgedIncludingThis, commentChance(this.personality)) : this.comments,
                }
                : {}),
        };
    }

    /** `previous` is the video swiped away, to notice a swipe that didn't move the feed on. */
    private async observe(arrivedAt: number, previous?: { caption: string; reelId?: string }): Promise<Observation> {
        let { screenshot, words, image, captionImage, inspection, caption, marks } = await this.capture();
        const retrySwipes: SwipeRecord[] = [];
        // A swipe can fail to move the feed on (seen on TikTok Shop posts):
        // the same video is still there, so swipe again from higher up.
        for (let retry = 1; retry <= MAX_SWIPE_RETRIES && previous && feedDidNotMove(previous, { caption, reelId: inspection.reelId }); retry++) {
            console.log(`[agent] swipe did not move the feed on; swiping again (${retry}/${MAX_SWIPE_RETRIES})`);
            retrySwipes.push(await this.swipe(true));
            arrivedAt = Date.now();
            ({ screenshot, words, image, captionImage, inspection, caption, marks } = await this.capture());
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
            index: this.videos, arrivedAt, observedAt: Date.now(), caption, isAd, retrySwipes, place: this.place, marks,
            strictAd: isAd || !this.adapter.strictAd ? Promise.resolve(isAd) : this.adapter.strictAd(screenshot).catch(() => false),
            ...(inspection.reelId ? { reelId: inspection.reelId } : {}),
        };
        const stem = path.join(this.logDirectory, String(this.videos).padStart(4, '0'));
        await Promise.all([
            writeFile(`${stem}.jpg`, image).catch(() => undefined),
            writeFile(`${stem}-caption.jpg`, captionImage).catch(() => undefined),
        ]);
        const autoSkip = autoSkipReason({ isAd, caption }) ?? inspection.autoSkip;
        const compare = FRAME_COMPARE
            ? await this.compareFrame(stem, {
                image, captionImage, caption, isAd, noControls: Boolean(inspection.noControls), kb: Math.round(screenshot.length / 1024),
                ...(autoSkip ? { autoSkip } : {}),
            }).catch((error: unknown) => {
                console.warn(`[agent] frame comparison failed: ${error instanceof Error ? error.message : String(error)}`);
                return undefined;
            })
            : undefined;
        return {
            video: this.videos, image, captionImage, caption, isAd, remainingMs: this.remainingMs, place: this.place,
            engagement: this.engagementFor(this.decisionMs.length + 1),
            ...(autoSkip ? { autoSkip } : {}),
            ...(compare ? { compare } : {}),
        };
    }

    /**
     * Carries out the plan for the current video, swipes, and observes the
     * next one. Returns a summary instead once the session time is up.
     * `logExtra` is added to this video's line in decisions.jsonl; `trace`
     * adds the caller's timings to its `spans`.
     */
    async step(plan: AgentPlan, logExtra: Record<string, unknown> = {}, trace: StepTrace = {}): Promise<{ observation: Observation } | { summary: SessionSummary }> {
        if (this.closed) return { summary: this.closed };
        if (this.busy) throw new Error('A step is already running');
        const video = this.current;
        if (!video) throw new Error('No video observed yet');
        this.busy = true;
        try {
            this.advancedOnItsOwn = false;
            const decidedAt = Date.now();
            const canSave = this.adapter.canSave;
            const supported = {
                ...plan, ...(canSave ? {} : { save: false }), ...(this.canComment() && this.commentsWarm() ? {} : { comment: null }),
                ...(plan.follow && plan.watch === 'full' && this.follows < this.followsAllowed() ? {} : { follow: false }),
                // Possibly the wrong account until it has been checked.
                ...(this.accountCheckAfter !== undefined ? { likeAtMs: null, save: false, comment: null, follow: false } : {}),
            };
            const timed = timePlan(supported, this.personality, {
                judged: this.decisionMs.length, likes: this.likes, saves: this.saves, comments: this.comments,
                ...(this.lastCommentAt !== undefined ? { lastCommentAt: this.lastCommentAt } : {}),
            });
            this.decisionMs.push(decidedAt - video.observedAt);
            if (logExtra.auto === undefined) this.timeToDecisionMs.push(decidedAt - video.arrivedAt);
            const actionSpans: NonNullable<VideoSpans['actions']> = [];

            const actions: Array<{ at: number; kind: 'like' | 'save' | 'comment' }> = [];
            if (timed.likeAtMs !== undefined) actions.push({ at: timed.likeAtMs, kind: 'like' });
            if (timed.saveAtMs !== undefined) actions.push({ at: timed.saveAtMs, kind: 'save' });
            if (timed.commentAtMs !== undefined) actions.push({ at: timed.commentAtMs, kind: 'comment' });
            actions.sort((a, b) => a.at - b.at);
            let liked = false;
            let saved = false;
            let commented: Awaited<ReturnType<AgentSession['leaveComment']>> | undefined;
            // Timings count from the video appearing, so the thinking time is part of
            // the watch. Actions already due run now, but never back to back.
            const shownAt = video.arrivedAt;
            let lastActionAt = -Infinity;
            for (const action of actions) {
                await sleep(Math.max(shownAt + action.at, lastActionAt + MIN_ACTION_GAP_MS) - Date.now());
                const actionStart = Date.now();
                if (action.kind === 'comment') {
                    commented = await this.leaveComment(timed.comment!);
                    lastActionAt = Date.now();
                    actionSpans.push({ kind: 'comment', at: [actionStart, lastActionAt] });
                    continue;
                }
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
                lastActionAt = Date.now();
                actionSpans.push({ kind: action.kind, at: [actionStart, lastActionAt] });
            }
            // After a comment the video has been on screen a long while already, and
            // it may have stopped behind the sheet: a short look, then move on.
            const watched: WatchOutcome = commented
                ? (await sleep(1500 + Math.random() * 3500), { by: 'commented' })
                : plan.watch === 'full'
                    ? await this.watchToEnd(shownAt, timed.watchMs, video.reelId)
                    : (await sleep(Math.max(shownAt + timed.watchMs, lastActionAt + MIN_ACTION_GAP_MS) - Date.now()), { by: 'timer' });
            const watchedAt = Date.now();

            const isAd = await video.strictAd;
            if (isAd) this.ads += 1;
            const onNiche = plan.onNiche >= 0.5;
            if (onNiche) this.onNiche += 1;
            if (video.place === 'feed') {
                this.feedVideos += 1;
                if (onNiche) this.feedOnNiche += 1;
            } else {
                this.searchVideos += 1;
                if (onNiche) this.searchOnNiche += 1;
            }
            // After the watch, like someone who decides at the end: follow the creator.
            const followStart = Date.now();
            const followed = supported.follow && !isAd ? await this.followCreator() : undefined;
            const followEnd = Date.now();
            if (followed) this.advancedOnItsOwn = false;
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
            let accountCheck: AccountCheck | undefined;
            let accountCheckAt: Span | undefined;
            if (!last && this.accountCheckAfter !== undefined && video.index >= this.accountCheckAfter) {
                const checkStart = Date.now();
                accountCheck = await this.checkAccount();
                accountCheckAt = [checkStart, Date.now()];
                // Back on the feed: whatever was there is swiped on as usual.
                this.advancedOnItsOwn = false;
            }
            let swipe: SwipeRecord | null = null;
            const detourStart = Date.now();
            const detour = last || this.accountCheckAfter !== undefined ? undefined : await this.searchDetour();
            const detourEnd = Date.now();
            if (last) await sleep(finalLingerMs());
            else if (detour) console.log(`[agent] ${detour === 'opened' ? 'on the search results' : 'back on the main feed'}`);
            else if (this.advancedOnItsOwn) console.log('[agent] already on the next video; not swiping');
            else swipe = await this.swipe(isAd || SHOP_POST.test(video.caption));
            const arrivedAt = Date.now();
            const swipeAt: Span | undefined = swipe ? [detourEnd, arrivedAt] : undefined;

            const rel = (at: number) => at - video.arrivedAt;
            const span = ([start, end]: Span): Span => [rel(start), rel(end)];
            const { marks } = video;
            const spans: VideoSpans = {
                ...(SETTLE_MS > 0 ? { settle: span([marks.startedAt, marks.settledAt]) } : {}),
                screenshot: span([marks.settledAt, marks.shotAt]),
                images: span([marks.shotAt, marks.imagesAt]),
                ocr: span([marks.imagesAt, marks.ocrAt]),
                inspect: span([marks.imagesAt, marks.inspectAt]),
                observed: rel(video.observedAt),
                ...(trace.model ? { model: span([trace.model.start, trace.model.end]) } : {}),
                decided: rel(decidedAt),
                ...(actionSpans.length ? { actions: actionSpans.map(({ kind, at }) => ({ kind, at: span(at) })) } : {}),
                watched: rel(watchedAt),
                ...(followed ? { follow: span([followStart, followEnd]) } : {}),
                ...(accountCheckAt ? { accountCheck: span(accountCheckAt) } : {}),
                ...(detour ? { search: span([detourStart, detourEnd]) } : {}),
                ...(swipeAt ? { swipe: span(swipeAt) } : {}),
                end: rel(arrivedAt),
            };

            await appendFile(path.join(this.logDirectory, 'decisions.jsonl'), `${JSON.stringify({
                video: video.index, caption: video.caption, isAd, ...(video.reelId ? { reelId: video.reelId } : {}),
                place: video.place, plan, timed, watched, liked, ...(canSave ? { saved } : {}), ...(commented ? { commented } : {}),
                ...(followed ? { followed } : {}), ...(detour ? { search: detour } : {}),
                ...(this.advancedOnItsOwn ? { advancedOnItsOwn: true } : {}),
                decisionMs: decidedAt - video.observedAt, screenMs: arrivedAt - video.arrivedAt, swipe,
                ...(video.retrySwipes.length ? { retrySwipes: video.retrySwipes } : {}),
                ...(accountCheck ? { accountCheck } : {}), ...logExtra,
                ...(last ? { last: true } : {}),
                spans,
            })}\n`).catch(() => undefined);

            if (last) return { summary: await this.stop('completed') };
            // When we didn't swipe, the app moved on itself: no "same video" check.
            return { observation: await this.observe(arrivedAt, swipe ? video : undefined) };
        } finally {
            this.busy = false;
        }
    }

    /**
     * Opens the search results once the feed has been scrolled long enough,
     * and leaves them after enough result videos. Returns what it did, or
     * undefined to swipe on as usual. A failed search is logged and the
     * session stays on the main feed; AppStuckError stops it.
     */
    private async searchDetour(): Promise<'opened' | 'left' | undefined> {
        const search = this.extras.search;
        if (!search) return undefined;
        if (this.searchState === 'pending' && Date.now() - this.startedAt >= search.afterMs) {
            this.searchState = 'done';
            if (!this.adapter.openSearch || !this.adapter.leaveSearch) {
                this.searchError = 'unsupported';
                console.log(`[agent] search skipped: not supported on ${this.adapter.label} yet`);
                return undefined;
            }
            try {
                console.log(`[agent] searching ${JSON.stringify(search.query)}`);
                await this.adapter.openSearch(this.context, search.query);
                this.searchState = 'in';
                this.place = 'search';
                return 'opened';
            } catch (error) {
                if (error instanceof AppStuckError) throw error;
                this.searchError = error instanceof Error ? error.message : String(error);
                console.log(`[agent] search failed, staying on the main feed: ${this.searchError}`);
                return undefined;
            }
        }
        if (this.searchState === 'in' && this.searchVideos >= search.videos) {
            this.searchState = 'done';
            await this.adapter.leaveSearch!(this.context);
            this.place = 'feed';
            return 'left';
        }
        return undefined;
    }

    /** Follows the video's creator; a failure is logged and the session goes on, AppStuckError stops it. */
    private async followCreator(): Promise<{ how: FollowHow; verified?: boolean; profileVideos?: number; ms?: number; error?: string }> {
        const modes = this.adapter.followModes ?? ['plus', 'profile'];
        const preferred: FollowHow = Math.random() < PROFILE_FOLLOW_CHANCE ? 'profile' : 'plus';
        const how: FollowHow = modes.includes(preferred) ? preferred : modes[0]!;
        try {
            const { verified, profileVideos, durationMs } = await this.adapter.follow!(this.context, how);
            this.follows += 1;
            console.log(`[agent] followed (${how}${profileVideos ? `, watched ${profileVideos} of their videos` : ''})${verified ? '' : ' (not confirmed)'} in ${(durationMs / 1000).toFixed(1)} s`);
            return { how, verified, ...(profileVideos ? { profileVideos } : {}), ms: durationMs };
        } catch (error) {
            if (error instanceof AppStuckError) throw error;
            const message = error instanceof Error ? error.message : String(error);
            console.log(`[agent] follow failed: ${message}`);
            return { how, error: message };
        }
    }

    /** Checks (and if needed switches) the account; a failure stops the session rather than scroll on the wrong one. */
    private async checkAccount(): Promise<AccountCheck> {
        const check = await this.adapter.ensureAccount!(this.context, this.account!);
        this.accountCheck = check;
        this.accountCheckAfter = undefined;
        console.log(`[agent] account check: was ${check.from}${check.switched ? `, switched to ${this.account}` : ''} (${(check.durationMs / 1000).toFixed(1)} s)`);
        return check;
    }

    /**
     * Comments on the video on screen. A failed comment is logged and the
     * video goes on; a comment sheet that won't close stops the session.
     */
    private async leaveComment(text: string): Promise<{ text: string; verified?: boolean; ms?: number; steps?: Record<string, number>; error?: string }> {
        try {
            const { verified, durationMs, steps } = await this.adapter.comment!(this.context, text);
            this.comments += 1;
            this.lastCommentAt = this.decisionMs.length;
            const timing = durationMs !== undefined ? ` in ${(durationMs / 1000).toFixed(1)} s ${JSON.stringify(steps ?? {})}` : '';
            console.log(`[agent] commented ${JSON.stringify(text)}${verified ? '' : ' (not confirmed)'}${timing}`);
            return { text, verified, ...(durationMs !== undefined ? { ms: durationMs } : {}), ...(steps ? { steps } : {}) };
        } catch (error) {
            if (error instanceof AppStuckError) throw error;
            const message = error instanceof Error ? error.message : String(error);
            console.log(`[agent] comment failed: ${message}`);
            return { text, error: message };
        }
    }

    /**
     * Keeps a `full` video on screen until it has played to the end (the
     * progress bar loops back to the start), the app moves on, or the cap.
     * Videos without a bar fall back to the timed watch. The cap and that timer
     * count from `shownAt`, when the video appeared.
     */
    private async watchToEnd(shownAt: number, timedWatchMs: number, reelId: string | undefined): Promise<WatchOutcome> {
        const capEnd = shownAt + FULL_WATCH_CAP_MS[this.personality];
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
            await sleep(shownAt + timedWatchMs - Date.now());
            return { by: 'timer' };
        }
        return { by: 'progress', completed: false, lastProgress };
    }

    /** `careful`: an ad, shop post or retry, where the app's ad swipe (if any) starts above the buttons. */
    private async swipe(careful = false): Promise<SwipeRecord> {
        if (careful && this.adapter.adSwipe) return swipeRecord('ad', await this.adapter.adSwipe(this.context));
        if (this.swipeStyle) {
            return swipeRecord(this.swipeStyle, await performSwipe(this.context.driver, profileSwipe(this.swipeStyle, Math.random, this.adapter.minSwipeTravel)));
        }
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
            comments: this.comments,
            follows: this.follows,
            feedVideos: this.feedVideos,
            feedOnNicheShare: this.feedVideos ? Math.round((this.feedOnNiche / this.feedVideos) * 100) / 100 : 0,
            ...(this.extras.search
                ? {
                    search: {
                        query: this.extras.search.query, videos: this.searchVideos, onNiche: this.searchOnNiche,
                        ...(this.searchError ? { error: this.searchError } : this.searchState === 'pending' ? { error: 'session ended first' } : {}),
                    },
                }
                : {}),
            goal: this.goal,
            likeRate: rate(this.likes),
            saveRate: rate(this.saves),
            ads: this.ads,
            medianDecisionMs: median(this.decisionMs),
            medianTimeToDecisionMs: median(this.timeToDecisionMs),
            medianSkipScreenMs: median(this.skipScreenMs),
            elapsedMs: Date.now() - this.startedAt,
            logDirectory: this.logDirectory,
            ...(this.accountCheck ? { accountCheck: this.accountCheck } : {}),
            ...(this.extras.source ? { source: this.extras.source } : {}),
            ...(this.extras.meta ? { meta: this.extras.meta } : {}),
        };
        this.closed = summary;
        await writeFile(path.join(this.logDirectory, 'summary.json'), JSON.stringify(summary, null, 2)).catch(() => undefined);
        await disconnectApp(this.context);
        // A failed report never fails the session.
        await writeRunReport(this.logDirectory).catch((error: unknown) => {
            console.log(`[agent] run report not written: ${error instanceof Error ? error.message : String(error)}`);
        });
        return summary;
    }
}
