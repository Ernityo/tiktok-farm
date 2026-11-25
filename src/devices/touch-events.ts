import dgram from 'node:dgram';

// Live touch overlay channel. Taps and swipes are performed by several
// processes (the web server's remote control, the scheduler worker, and the
// plugin child processes that drive Appium), but only the web server talks
// to the browser. Every sender fires a tiny fire-and-forget UDP datagram at
// loopback; the web server listens and fans events out over SSE. Nobody
// listening (web server down) just means the datagram is dropped — touch
// visualisation must never slow down or break automation.

export type TouchEvent =
    | { type: 'tap'; x: number; y: number }
    | { type: 'swipe'; startX: number; startY: number; endX: number; endY: number; durationMs: number };

export type TouchSource = 'remote' | 'automation';

export interface TouchEventMessage {
    udid: string;
    source: TouchSource;
    at: number;
    touch: TouchEvent;
}

const HOST = '127.0.0.1';

export function touchEventsPort(): number {
    return Number(process.env.TOUCH_EVENTS_PORT ?? 9399);
}

let sender: dgram.Socket | undefined;

/**
 * Report a touch the device is about to perform. `udid` defaults to
 * IOS_UDID, which plugin child processes always have. Never throws.
 */
export function emitTouch(touch: TouchEvent, options: { udid?: string; source?: TouchSource } = {}): void {
    const udid = options.udid ?? process.env.IOS_UDID;
    if (!udid) return;
    try {
        if (!sender) {
            sender = dgram.createSocket('udp4');
            sender.on('error', () => undefined);
            sender.unref();
        }
        const message: TouchEventMessage = { udid, source: options.source ?? 'automation', at: Date.now(), touch };
        sender.send(JSON.stringify(message), touchEventsPort(), HOST, () => undefined);
    } catch {
        // Visualisation only — ignore.
    }
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

export function parseTouchEventMessage(raw: string): TouchEventMessage | undefined {
    try {
        const value = JSON.parse(raw) as Partial<TouchEventMessage>;
        if (typeof value.udid !== 'string' || !value.touch) return;
        const touch = value.touch as Partial<Record<string, unknown>>;
        const source: TouchSource = value.source === 'remote' ? 'remote' : 'automation';
        const at = isFiniteNumber(value.at) ? value.at : Date.now();
        if (touch.type === 'tap' && isFiniteNumber(touch.x) && isFiniteNumber(touch.y)) {
            return { udid: value.udid, source, at, touch: { type: 'tap', x: touch.x, y: touch.y } };
        }
        if (touch.type === 'swipe' && [touch.startX, touch.startY, touch.endX, touch.endY, touch.durationMs].every(isFiniteNumber)) {
            return {
                udid: value.udid, source, at,
                touch: {
                    type: 'swipe', startX: touch.startX as number, startY: touch.startY as number,
                    endX: touch.endX as number, endY: touch.endY as number, durationMs: touch.durationMs as number,
                },
            };
        }
    } catch {
        // fall through
    }
    return;
}

type Listener = (message: TouchEventMessage) => void;

/** Web-server side: receives touch datagrams and dispatches them per device. */
export class TouchEventHub {
    private socket?: dgram.Socket;
    private readonly listeners = new Map<string, Set<Listener>>();

    async start(port = touchEventsPort()): Promise<void> {
        if (this.socket) return;
        const socket = dgram.createSocket('udp4');
        socket.on('message', (buffer) => {
            const message = parseTouchEventMessage(buffer.toString());
            if (message) this.dispatch(message);
        });
        await new Promise<void>((resolve) => {
            socket.once('error', (error) => {
                // Port taken (e.g. a second web server): the overlay just stays
                // empty, the dashboard keeps working.
                console.warn(`Touch overlay disabled: could not listen on udp://${HOST}:${port} (${error.message})`);
                socket.close();
                resolve();
            });
            socket.bind(port, HOST, () => {
                this.socket = socket;
                socket.removeAllListeners('error');
                socket.on('error', () => undefined);
                resolve();
            });
        });
    }

    subscribe(udid: string, listener: Listener): () => void {
        let set = this.listeners.get(udid);
        if (!set) this.listeners.set(udid, set = new Set());
        set.add(listener);
        return () => {
            set.delete(listener);
            if (!set.size) this.listeners.delete(udid);
        };
    }

    dispatch(message: TouchEventMessage): void {
        for (const listener of this.listeners.get(message.udid) ?? []) listener(message);
    }

    async close(): Promise<void> {
        const socket = this.socket;
        this.socket = undefined;
        if (socket) await new Promise<void>((resolve) => socket.close(() => resolve()));
    }
}
