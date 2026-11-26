// Reads the on-screen keyboard through WebDriverAgent and taps its keys, for
// the typing engine in typing.ts. Element lookups need a WDA session; taps
// go through the sessionless /wda/absolute-actions like every other touch.

import { humanTap, type Point, type PointerAction } from './humanize.js';
import type { KeyboardDevice, KeyboardKey, KeyRect } from './typing.js';

type Request = (pathname: string, options?: RequestInit) => Promise<Response>;

const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';
interface SourceNode { type?: string; label?: string | null; name?: string | null; rect?: KeyRect; children?: SourceNode[] }
const TEXT_INPUTS = "(type == 'XCUIElementTypeSearchField' OR type == 'XCUIElementTypeTextField'"
    + " OR type == 'XCUIElementTypeSecureTextField' OR type == 'XCUIElementTypeTextView') AND visible == 1";

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function predicateString(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export class WdaKeyboard implements KeyboardDevice {
    constructor(
        private readonly request: Request,
        private readonly sessionId: string,
        private readonly toW3c: (actions: PointerAction[]) => unknown,
    ) {}

    private async post(pathname: string, body: unknown): Promise<Response> {
        return this.request(pathname, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    private async findElements(using: string, value: string): Promise<string[]> {
        const response = await this.post(`/session/${this.sessionId}/elements`, { using, value });
        const payload = await response.json() as { value?: Array<Record<string, string>> };
        return (payload.value ?? []).map((element) => element[ELEMENT_KEY] ?? element.ELEMENT).filter(Boolean);
    }

    private async rect(id: string): Promise<KeyRect> {
        const response = await this.request(`/session/${this.sessionId}/element/${id}/rect`);
        return (await response.json() as { value: KeyRect }).value;
    }

    // One page-source request returns every key's label and frame (~2 s),
    // instead of two requests per key. Shift and return are Buttons on iOS,
    // the rest are Keys; both live under the Keyboard element.
    async readKeyboard(): Promise<KeyboardKey[]> {
        const response = await this.request(`/session/${this.sessionId}/source?format=json`);
        const root = (await response.json() as { value?: SourceNode }).value;
        const keys: KeyboardKey[] = [];
        const walk = (node: SourceNode, inKeyboard: boolean) => {
            const inside = inKeyboard || node.type === 'Keyboard';
            if (inside && (node.type === 'Key' || node.type === 'Button') && node.rect) {
                keys.push({ label: node.label ?? node.name ?? '', rect: node.rect });
            }
            for (const child of node.children ?? []) walk(child, inside);
        };
        if (root) walk(root, false);
        return keys;
    }

    async hasKey(label: string): Promise<boolean> {
        const ids = await this.findElements('predicate string',
            `(type == 'XCUIElementTypeKey' OR type == 'XCUIElementTypeButton') AND label == ${predicateString(label)}`);
        return ids.length > 0;
    }

    /** Where the keyboard sits on screen, or undefined when none is shown. */
    async frame(): Promise<KeyRect | undefined> {
        const [id] = await this.findElements('class name', 'XCUIElementTypeKeyboard');
        return id ? this.rect(id) : undefined;
    }

    async keyboardVisible(): Promise<boolean> {
        return (await this.findElements('class name', 'XCUIElementTypeKeyboard')).length > 0;
    }

    async perform(actions: PointerAction[]): Promise<void> {
        await this.post('/wda/absolute-actions', { actions: this.toW3c(actions) });
    }

    /**
     * Several taps in one request on the patched route
     * (Patches/appium-webdriveragent-8.9.1-tap-sequence.patch). False when
     * this WDA build doesn't have it: never send a multi-tap to
     * /wda/absolute-actions, which plays it as one swipe (swipe-typing).
     */
    async performSequence(actions: PointerAction[]): Promise<boolean> {
        if (WdaKeyboard.noSequences.has(this.sessionId)) return false;
        const response = await this.post('/wda/absolute-tap-sequence', { actions: this.toW3c(actions) });
        if (response.status === 404) {
            WdaKeyboard.noSequences.add(this.sessionId);
            console.log('[typing] this WebDriverAgent has no tap-sequence route (run npm run wda:prepare); typing one key per request');
            return false;
        }
        if (!response.ok) throw new Error(`Tap sequence failed: ${await response.text()}`);
        return true;
    }

    private static readonly noSequences = new Set<string>();

    /**
     * Opens the keyboard by tapping `field`, or else the first text field on
     * screen, then waits for it to slide up.
     */
    async open(field: Point | undefined, onTap?: (point: Point) => void): Promise<void> {
        if (await this.keyboardVisible()) return;
        let target = field;
        if (!target) {
            const [id] = await this.findElements('predicate string', TEXT_INPUTS);
            if (!id) throw new Error('The keyboard is not open and there is no text field on screen to tap');
            const rect = await this.rect(id);
            target = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        }
        const { point, actions } = humanTap(target, { radius: 3 });
        onTap?.(point);
        await this.perform(actions);
        for (let check = 0; check < 12; check += 1) {
            await sleep(250);
            if (await this.keyboardVisible()) {
                // Let the slide-up animation finish before reading key frames.
                await sleep(350);
                return;
            }
        }
        throw new Error('The keyboard did not open after tapping the text field');
    }
}
