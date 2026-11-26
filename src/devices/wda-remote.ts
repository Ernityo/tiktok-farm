import { coordinatesForProfile } from './coordinates.js';
import { humanSwipe, humanTap, pathFromActions, type PointerAction, type Random } from './humanize.js';
import type { TouchEvent } from './touch-events.js';
import { cachedKeyboard, MAX_TYPING_LENGTH, typeOnKeyboard, type KeyboardLayerCache, type TypingReport } from './typing.js';
import { WdaKeyboard } from './wda-keyboard.js';

const DEFAULT_TIMEOUT_MS = 10_000;
// IOHID consumer page / Power usage: the side (lock) button.
const HID_CONSUMER_PAGE = 0x0c;
const HID_POWER_USAGE = 0x30;
const SIDE_BUTTON_PRESS_S = 0.15;

export interface ScreenSize {
    width: number;
    height: number;
}

export interface ScreenInfo {
    screenSize: ScreenSize;
    scale: number;
    statusBarSize?: ScreenSize;
}

export type RemoteAction =
    // `humanize`: vary press length and add a tiny finger roll; the point
    // itself is kept (a mouse click is already imprecise).
    | { type: 'tap'; x: number; y: number; humanize?: boolean }
    | { type: 'home' }
    | { type: 'lock' }
    | { type: 'wake' }
    | { type: 'unlock' }
    | { type: 'volumeUp' }
    | { type: 'volumeDown' }
    // Type text by tapping each key on the on-screen keyboard, with human
    // timing (see typing.ts). Opens the keyboard first if needed: by tapping
    // (x, y) when given, else the first text field on screen.
    | { type: 'type'; text: string; x?: number; y?: number; wpm?: number; typoRate?: number }
    | {
        type: 'swipe';
        startX: number;
        startY: number;
        endX: number;
        endY: number;
        durationMs: number;
        // 'path': keep the given endpoints and duration but follow a curved,
        // variable-speed trajectory. 'full': also randomize endpoints and
        // duration. Omitted: exact straight-line swipe (calibration, plugins).
        humanize?: 'path' | 'full';
    };

export interface PerformActionHooks {
    /** Called with the touch about to be performed, after any randomization. */
    onTouch?(touch: TouchEvent): void;
}

export interface PasscodeKeypadLayout {
    // x for columns [1,4,7/0], [2,5,8], [3,6,9]
    columnX: [number, number, number];
    // y for rows [1,2,3], [4,5,6], [7,8,9], [0]
    rowY: [number, number, number, number];
}

// Standard iOS numeric keypad: 1-9 in a 3x3 grid, 0 centered beneath it.
// Row spacing may vary by device profile, so rows are stored explicitly.
export function passcodeDigitPoint(digit: number, layout: PasscodeKeypadLayout): { x: number; y: number } {
    if (digit === 0) {
        return { x: layout.columnX[1], y: layout.rowY[3] };
    }
    const index = digit - 1;
    return {
        x: layout.columnX[index % 3],
        y: layout.rowY[Math.floor(index / 3)],
    };
}

interface WdaPayload<T> {
    value: T;
}

interface W3cActionItem {
    type: 'pointerMove' | 'pointerDown' | 'pointerUp' | 'pause';
    duration?: number;
    x?: number;
    y?: number;
    origin?: 'viewport';
    button?: number;
}

interface W3cPointerSource {
    type: 'pointer';
    id: string;
    parameters: { pointerType: 'touch' };
    actions: W3cActionItem[];
}

export interface RemoteControl {
    getScreenInfo(udid: string): Promise<ScreenInfo>;
    getScreenshot(udid: string): Promise<Buffer>;
    /** `signal` should be tied to the client request so the upstream device stream closes when the viewer leaves. */
    getMjpegStream(udid: string, signal?: AbortSignal): Promise<Response>;
    performAction(udid: string, action: RemoteAction, hooks?: PerformActionHooks): Promise<void>;
    isLocked(udid: string): Promise<boolean>;
    /** Drop any cached client for this device so its next use re-reads devices.json. */
    forget?(udid: string): void;
}

export class RemoteDeviceError extends Error {}

/** Keyboard layers read so far, per phone and keyboard position, for the life of the process. */
const keyboardLayers = new Map<string, KeyboardLayerCache>();

export class WdaRemoteControl {
    readonly wdaUrl: string;
    readonly mjpegUrl: string;
    readonly deviceUdid: string | undefined;
    readonly fetch: typeof fetch;
    readonly timeoutMs: number;
    readonly passcode: string | undefined;
    readonly passcodeKeypadLayout: PasscodeKeypadLayout;
    private cachedScreenInfo: ScreenInfo | undefined;

    constructor({
        wdaUrl = process.env.WDA_URL ?? 'http://127.0.0.1:8100',
        mjpegUrl = process.env.MJPEG_URL ?? 'http://127.0.0.1:9100',
        deviceUdid = process.env.IOS_UDID,
        fetchImpl = fetch,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        passcode = process.env.IOS_PASSCODE,
        passcodeKeypadLayout = coordinatesForProfile().passcodeKeypad,
    }: {
        wdaUrl?: string;
        mjpegUrl?: string;
        deviceUdid?: string;
        fetchImpl?: typeof fetch;
        timeoutMs?: number;
        passcode?: string;
        passcodeKeypadLayout?: PasscodeKeypadLayout;
    } = {}) {
        this.wdaUrl = wdaUrl.replace(/\/$/, '');
        this.mjpegUrl = mjpegUrl.replace(/\/$/, '');
        this.deviceUdid = deviceUdid;
        this.fetch = fetchImpl;
        this.timeoutMs = timeoutMs;
        this.passcode = passcode;
        this.passcodeKeypadLayout = passcodeKeypadLayout;
    }

    assertTarget(udid: string): void {
        if (!this.deviceUdid || udid !== this.deviceUdid) {
            throw new RemoteDeviceError('Remote control is not configured for this device');
        }
    }

    async request(pathname: string, options: RequestInit = {}): Promise<Response> {
        // WDA answers a bodyless POST with an empty 400, so give command
        // endpoints like /wda/homescreen and /wda/lock an empty JSON object.
        if (options.method === 'POST' && options.body === undefined) {
            options = { ...options, headers: { 'content-type': 'application/json', ...options.headers }, body: '{}' };
        }
        let response: Response;
        try {
            response = await this.fetch(`${this.wdaUrl}${pathname}`, {
                ...options,
                signal: AbortSignal.timeout(this.timeoutMs),
            });
        } catch (error) {
            throw new RemoteDeviceError(`WebDriverAgent is unavailable: ${errorMessage(error)}`);
        }
        if (!response.ok) {
            const detail = await response.text();
            throw new RemoteDeviceError(`WebDriverAgent returned ${response.status}${detail ? `: ${detail}` : ''}`);
        }
        return response;
    }

    async getScreenInfo(udid: string): Promise<ScreenInfo> {
        this.assertTarget(udid);
        const response = await this.request('/wda/screen');
        const payload = await response.json() as WdaPayload<ScreenInfo>;
        this.cachedScreenInfo = payload.value;
        return payload.value;
    }

    async getScreenshot(udid: string): Promise<Buffer> {
        this.assertTarget(udid);
        const response = await this.request('/screenshot');
        const payload = await response.json() as WdaPayload<unknown>;
        if (typeof payload.value !== 'string') {
            throw new RemoteDeviceError('WebDriverAgent returned an invalid screenshot');
        }
        return Buffer.from(payload.value, 'base64');
    }

    async getMjpegStream(udid: string, signal?: AbortSignal): Promise<Response> {
        this.assertTarget(udid);
        // A connect deadline for the handshake, then hand the stream over to the
        // caller's signal so it lives exactly as long as the client stays connected.
        const connect = new AbortController();
        const timer = setTimeout(() => connect.abort(new RemoteDeviceError('WDA video stream did not connect in time')), this.timeoutMs);
        const combined = signal ? AbortSignal.any([signal, connect.signal]) : connect.signal;
        let response: Response;
        try {
            response = await this.fetch(`${this.mjpegUrl}/`, { signal: combined });
        } catch (error) {
            throw new RemoteDeviceError(`WDA video stream is unavailable: ${errorMessage(error)}`);
        } finally {
            clearTimeout(timer);
        }
        if (!response.ok || !response.body) {
            throw new RemoteDeviceError(`WDA video stream returned ${response.status}`);
        }
        return response;
    }

    async isLocked(udid: string): Promise<boolean> {
        this.assertTarget(udid);
        const response = await this.request('/wda/locked');
        const payload = await response.json() as WdaPayload<boolean>;
        return payload.value;
    }

    async unlock(udid: string): Promise<void> {
        this.assertTarget(udid);
        if (!(await this.isLocked(udid))) return;
        if (this.passcode !== undefined && !/^\d+$/.test(this.passcode)) {
            throw new RemoteDeviceError('IOS_PASSCODE must contain only digits');
        }
        // WDA's own /wda/unlock just presses Home twice, which only works on
        // Home-button phones: on Face ID models (iPhone X and later) the lock
        // screen stays up until it is swiped away. So press Home once to wake
        // the screen, then swipe up from the bottom edge. Without a passcode
        // that lands on the last app / Home Screen; with one, the keypad.
        await this.pressHome();
        await sleep(600);
        const { screenSize } = await this.getScreenInfo(udid);
        await this.swipeUpFromBottom(screenSize);
        await sleep(800);
        if (!this.passcode) {
            if (await this.isLocked(udid)) {
                // A notification or the screen dimming can eat the first swipe.
                await this.pressHome();
                await sleep(600);
                await this.swipeUpFromBottom(screenSize);
                await sleep(800);
            }
            if (await this.isLocked(udid)) {
                throw new RemoteDeviceError('Device is still locked after swiping up; if it has a passcode, save it on the device page');
            }
            return;
        }
        for (const character of this.passcode) {
            const digit = Number(character);
            if (!Number.isInteger(digit) || digit < 0 || digit > 9) {
                throw new RemoteDeviceError('IOS_PASSCODE must contain only digits');
            }
            const { x, y } = passcodeDigitPoint(digit, this.passcodeKeypadLayout);
            const { actions } = planTouchGesture({ type: 'tap', x, y, humanize: true }, { width: Infinity, height: Infinity });
            await this.request('/wda/absolute-actions', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ actions: pointerSource(actions.map(withViewportOrigin)) }),
            });
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (await this.isLocked(udid)) {
            throw new RemoteDeviceError('Device is still locked after entering the passcode');
        }
    }

    async lock(udid: string): Promise<void> {
        this.assertTarget(udid);
        if (await this.isLocked(udid)) return;
        // WDA's /wda/lock calls XCTest's pressLockButton, which iOS ignores
        // (it times out waiting for the lock). A synthesized side-button press
        // works, as long as it is held long enough: 0.05s is ignored, 0.15s
        // locks. The IOHID route needs a session, so reuse the running one
        // (an Appium session, say) rather than replacing it, else open a
        // short-lived one.
        const status = await (await this.request('/status')).json() as { sessionId?: string | null };
        const sessionId = status.sessionId ?? await this.createSession();
        try {
            // The first IOHID event on a freshly opened session is sometimes
            // dropped, so press a second time if the first one didn't take.
            // A late-landing first press just leaves the second one waking
            // the (still locked) screen.
            for (let press = 0; press < 2; press += 1) {
                await this.request(`/session/${sessionId}/wda/performIoHidEvent`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ page: HID_CONSUMER_PAGE, usage: HID_POWER_USAGE, duration: SIDE_BUTTON_PRESS_S }),
                });
                for (let check = 0; check < 6; check += 1) {
                    await sleep(200);
                    if (await this.isLocked(udid)) return;
                }
            }
        } finally {
            if (!status.sessionId) await this.request(`/session/${sessionId}`, { method: 'DELETE' }).catch(() => {});
        }
        throw new RemoteDeviceError('Device did not lock after pressing the side button');
    }

    private async createSession(): Promise<string> {
        const response = await this.request('/session', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ capabilities: { alwaysMatch: {} } }),
        });
        const payload = await response.json() as { sessionId?: string; value?: { sessionId?: string } };
        const sessionId = payload.sessionId ?? payload.value?.sessionId;
        if (!sessionId) throw new RemoteDeviceError('WebDriverAgent did not return a session id');
        return sessionId;
    }

    private async pressHome(): Promise<void> {
        await this.request('/wda/pressButton', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'home' }),
        });
    }

    private async swipeUpFromBottom({ width, height }: ScreenSize): Promise<void> {
        const x = Math.round(width / 2);
        const gesture = planTouchGesture({
            type: 'swipe', startX: x, startY: height - 8, endX: x, endY: Math.round(height * 0.45),
            durationMs: 250, humanize: 'path',
        }, { width, height });
        await this.request('/wda/absolute-actions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ actions: pointerSource(gesture.actions.map(withViewportOrigin)) }),
        });
    }

    /**
     * Types `text` on the phone like a person: opens the keyboard if needed,
     * then taps every key with realistic rhythm. Reuses a running WDA session
     * (an Appium one, say) or opens a short-lived one for the key lookups.
     */
    async typeText(
        udid: string,
        text: string,
        options: { field?: { x: number; y: number }; wpm?: number; typoRate?: number; onTouch?(touch: TouchEvent): void } = {},
    ): Promise<TypingReport> {
        this.assertTarget(udid);
        if (typeof text !== 'string' || !text.length) throw new RemoteDeviceError('Enter some text to type');
        if (Array.from(text).length > MAX_TYPING_LENGTH) {
            throw new RemoteDeviceError(`Text is too long to type (max ${MAX_TYPING_LENGTH} characters)`);
        }
        if (options.field) {
            const screen = this.cachedScreenInfo ?? await this.getScreenInfo(udid);
            if (!validatePoint(options.field.x, options.field.y, screen.screenSize)) {
                throw new RemoteDeviceError('Text field coordinates are outside the device screen');
            }
        }
        const onTap = options.onTouch ? (point: { x: number; y: number }) => options.onTouch?.({ type: 'tap', x: point.x, y: point.y }) : undefined;
        const status = await (await this.request('/status')).json() as { sessionId?: string | null };
        const sessionId = status.sessionId ?? await this.createSession();
        try {
            const keyboard = new WdaKeyboard(
                (pathname, init) => this.request(pathname, init),
                sessionId,
                (actions) => pointerSource(actions.map(withViewportOrigin)),
            );
            await keyboard.open(options.field, onTap);
            // Same phone, same keyboard position: the layout is the same, so
            // each layer is read in full (seconds on a busy app) only once.
            const frame = await keyboard.frame();
            const key = frame ? `${udid}|${frame.x},${frame.y},${frame.width},${frame.height}` : undefined;
            let cache = key ? keyboardLayers.get(key) : undefined;
            if (key && !cache) keyboardLayers.set(key, cache = { layers: [] });
            const device = cache ? cachedKeyboard(keyboard, cache) : keyboard;
            return await typeOnKeyboard(device, text, { wpm: options.wpm, typoRate: options.typoRate, onTap });
        } catch (error) {
            if (error instanceof RemoteDeviceError) throw error;
            throw new RemoteDeviceError(errorMessage(error));
        } finally {
            if (!status.sessionId) await this.request(`/session/${sessionId}`, { method: 'DELETE' }).catch(() => {});
        }
    }

    async performAction(udid: string, action: RemoteAction, hooks: PerformActionHooks = {}): Promise<void> {
        this.assertTarget(udid);
        if (action.type === 'type') {
            const field = action.x !== undefined && action.y !== undefined ? { x: action.x, y: action.y } : undefined;
            await this.typeText(udid, action.text, { field, wpm: action.wpm, typoRate: action.typoRate, onTouch: hooks.onTouch });
            return;
        }
        if (action.type === 'home') {
            await this.request('/wda/homescreen', { method: 'POST' });
            return;
        }
        if (action.type === 'unlock') {
            await this.unlock(udid);
            return;
        }
        if (action.type === 'lock') {
            await this.lock(udid);
            return;
        }
        if (action.type === 'wake') {
            // A Home press lights the screen without leaving the lock screen.
            await this.pressHome();
            return;
        }
        if (action.type === 'volumeUp' || action.type === 'volumeDown') {
            await this.request('/wda/pressButton', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name: action.type === 'volumeUp' ? 'volumeup' : 'volumedown' }),
            });
            return;
        }
        // Screen size is static hardware info — reuse the cached value from a
        // prior getScreenInfo() call instead of paying a full WDA round trip
        // just to validate coordinates on every single tap/swipe.
        const screen = this.cachedScreenInfo ?? await this.getScreenInfo(udid);
        validateAction(action, screen.screenSize);
        const gesture = planTouchGesture(action, screen.screenSize);
        hooks.onTouch?.(gesture.touch);
        await this.request('/wda/absolute-actions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ actions: pointerSource(gesture.actions.map(withViewportOrigin)) }),
        });
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function validatePoint(x: number, y: number, { width, height }: ScreenSize): boolean {
    return Number.isFinite(x) && Number.isFinite(y)
        && x >= 0 && x <= width && y >= 0 && y <= height;
}

function validateAction(action: RemoteAction, screenSize: ScreenSize): void {
    if (action.type !== 'tap' && action.type !== 'swipe') return;
    const valid = action.type === 'tap'
        ? validatePoint(action.x, action.y, screenSize)
        : validatePoint(action.startX, action.startY, screenSize)
            && validatePoint(action.endX, action.endY, screenSize);
    if (!valid) {
        throw new RemoteDeviceError('Touch coordinates are outside the device screen');
    }
}

function pointerSource(actions: W3cActionItem[]): W3cPointerSource[] {
    return [{
        type: 'pointer',
        id: 'finger1',
        parameters: { pointerType: 'touch' },
        actions,
    }];
}

export interface TouchGesture {
    actions: PointerAction[];
    touch: TouchEvent;
}

const EXACT_TAP_HOLD_MS = 80;
const EXACT_SWIPE_HOLD_MS = 100;

/**
 * Turn a dashboard tap/swipe into the pointer actions to perform plus the
 * touch to show on the live overlay, applying the requested randomization.
 * Points are kept on screen.
 */
export function planTouchGesture(
    action: Extract<RemoteAction, { type: 'tap' | 'swipe' }>,
    screenSize: ScreenSize,
    random: Random = Math.random,
): TouchGesture {
    const keepOnScreen = (items: PointerAction[]): PointerAction[] => items.map((item) => item.type === 'pointerMove'
        ? { ...item, x: Math.min(screenSize.width, Math.max(0, item.x)), y: Math.min(screenSize.height, Math.max(0, item.y)) }
        : item);
    if (action.type === 'tap') {
        const actions = keepOnScreen(action.humanize === true
            ? humanTap({ x: action.x, y: action.y }, { radius: 0 }, random).actions
            : [
                { type: 'pointerMove', duration: 0, x: action.x, y: action.y },
                { type: 'pointerDown', button: 0 },
                { type: 'pause', duration: EXACT_TAP_HOLD_MS },
                { type: 'pointerUp', button: 0 },
            ]);
        return { actions, touch: { type: 'tap', x: action.x, y: action.y } };
    }
    const from = { x: action.startX, y: action.startY };
    const to = { x: action.endX, y: action.endY };
    let actions: PointerAction[];
    if (action.humanize === 'full') {
        actions = humanSwipe(from, to, action.durationMs, {}, random).actions;
    } else if (action.humanize === 'path') {
        const none = { x: 0, y: 0 };
        actions = humanSwipe(from, to, action.durationMs, { startRadius: none, endRadius: none, durationJitter: 0 }, random).actions;
    } else {
        actions = [
            { type: 'pointerMove', duration: 0, x: from.x, y: from.y },
            { type: 'pointerDown', button: 0 },
            { type: 'pause', duration: EXACT_SWIPE_HOLD_MS },
            { type: 'pointerMove', duration: action.durationMs, x: to.x, y: to.y },
            { type: 'pointerUp', button: 0 },
        ];
    }
    actions = keepOnScreen(actions);
    return { actions, touch: swipeTouch(actions) };
}

/** Overlay event for a swipe, including its real trajectory. */
export function swipeTouch(actions: readonly PointerAction[]): Extract<TouchEvent, { type: 'swipe' }> {
    const path = pathFromActions(actions);
    const start = path[0] ?? { x: 0, y: 0, t: 0 };
    const end = path.at(-1) ?? start;
    const movementMs = actions.reduce((sum, item) => sum + (item.type === 'pointerMove' ? item.duration : 0), 0);
    return { type: 'swipe', startX: start.x, startY: start.y, endX: end.x, endY: end.y, durationMs: movementMs, path };
}

function withViewportOrigin(item: PointerAction): W3cActionItem {
    return item.type === 'pointerMove' ? { ...item, origin: 'viewport' } : item;
}
