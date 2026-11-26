import assert from 'node:assert/strict';
import test from 'node:test';

import type { PointerAction } from '../src/devices/humanize.js';
import {
    cachedKeyboard, describeKeyboard, keyIntervalMs, keyPressPoint, shiftKey, spaceKey, typeOnKeyboard,
    type KeyboardDevice, type KeyboardKey, type KeyboardLayerCache,
} from '../src/devices/typing.js';

function seeded(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ---- a simulated 375pt-wide iOS keyboard --------------------------------

type Layer = 'lower' | 'upper' | 'numbers' | 'symbols';
const KEY_W = 31.5;
const KEY_H = 42;
const ROW_Y = [450, 504, 558, 612];

function row(labels: string[], y: number, startX: number): KeyboardKey[] {
    return labels.map((label, index) => ({ label, rect: { x: startX + index * (KEY_W + 6), y, width: KEY_W, height: KEY_H } }));
}

function layerKeys(layer: Layer): KeyboardKey[] {
    const letters = [['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'], ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'], ['z', 'x', 'c', 'v', 'b', 'n', 'm']];
    const numbers = [['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'], ['-', '/', ':', ';', '(', ')', '$', '&', '@', '"'], ['.', ',', '?', '!', "'"]];
    const symbols = [['[', ']', '{', '}', '#', '%', '^', '*', '+', '='], ['_', '\\', '|', '~', '<', '>', '€', '£', '¥', '•'], ['.', ',', '?', '!', "'"]];
    const grid = layer === 'numbers' ? numbers : layer === 'symbols' ? symbols
        : letters.map((r) => r.map((label) => (layer === 'upper' ? label.toUpperCase() : label)));
    const rowShift = layer === 'lower' || layer === 'upper' ? 'shift' : layer === 'numbers' ? '#+=' : '123';
    return [
        ...row(grid[0], ROW_Y[0], 3),
        ...row(grid[1], ROW_Y[1], grid[1].length === 9 ? 22 : 3),
        { label: rowShift, rect: { x: 3, y: ROW_Y[2], width: 42, height: KEY_H } },
        ...row(grid[2], ROW_Y[2], 56),
        { label: 'delete', rect: { x: 330, y: ROW_Y[2], width: 42, height: KEY_H } },
        { label: layer === 'lower' || layer === 'upper' ? 'more' : 'letters', rect: { x: 3, y: ROW_Y[3], width: 87, height: KEY_H } },
        { label: 'space', rect: { x: 96, y: ROW_Y[3], width: 183, height: KEY_H } },
        { label: 'return', rect: { x: 285, y: ROW_Y[3], width: 87, height: KEY_H } },
    ];
}

class FakeKeyboard implements KeyboardDevice {
    text = '';
    layer: Layer = 'upper'; // empty field: auto-capitalized
    clock = 0;
    taps: Array<{ t: number; label: string }> = [];

    private autoCap(): Layer {
        return this.text === '' || /[.!?] $/.test(this.text) ? 'upper' : 'lower';
    }

    private press(label: string): void {
        if (label === 'shift') this.layer = this.layer === 'upper' ? 'lower' : 'upper';
        else if (label === '#+=') this.layer = 'symbols';
        else if (label === '123') this.layer = 'numbers';
        else if (label === 'more') this.layer = 'numbers';
        else if (label === 'letters') this.layer = this.autoCap();
        else if (label === 'delete') { this.text = Array.from(this.text).slice(0, -1).join(''); if (this.layer !== 'numbers' && this.layer !== 'symbols') this.layer = this.autoCap(); }
        else if (label === 'space') { this.text += ' '; this.layer = this.autoCap(); }
        else if (label === 'return') { this.text += '\n'; this.layer = 'upper'; }
        else {
            this.text += label;
            if (this.layer === 'upper') this.layer = 'lower';
            if (label === "'") this.layer = 'lower';
        }
    }

    async readKeyboard(): Promise<KeyboardKey[]> { this.clock += 400; return layerKeys(this.layer); }
    async hasKey(label: string): Promise<boolean> { this.clock += 60; return layerKeys(this.layer).some((key) => key.label === label); }

    async perform(actions: PointerAction[]): Promise<void> {
        let x = 0;
        let y = 0;
        for (const action of actions) {
            if (action.type === 'pointerMove') { x = action.x; y = action.y; this.clock += action.duration; }
            if (action.type === 'pause') this.clock += action.duration;
            if (action.type === 'pointerDown') {
                const key = layerKeys(this.layer).find(({ rect }) => x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height);
                assert.ok(key, `tap at (${x}, ${y}) missed every key`);
                this.taps.push({ t: this.clock, label: key.label });
                this.press(key.label);
            }
        }
    }
}

function options(device: FakeKeyboard, seed: number, extra: Record<string, unknown> = {}) {
    return {
        random: seeded(seed),
        now: () => device.clock,
        sleep: async (ms: number) => { device.clock += ms; },
        ...extra,
    };
}

// ---- tests --------------------------------------------------------------

test('describeKeyboard finds rows, layer case and the special keys by position', () => {
    const lower = describeKeyboard(layerKeys('lower'));
    assert.equal(lower.kind, 'lower');
    assert.equal(lower.rows.length, 4);
    assert.equal(spaceKey(lower)?.label, 'space');
    assert.equal(shiftKey(lower)?.label, 'shift');
    assert.equal(describeKeyboard(layerKeys('upper')).kind, 'upper');
    assert.equal(describeKeyboard(layerKeys('numbers')).kind, 'other');
    assert.equal(shiftKey(describeKeyboard(layerKeys('numbers')))?.label, '#+=');
});

test('types plain text key by key, unshifting the auto-capitalized first letter', async () => {
    const device = new FakeKeyboard();
    const report = await typeOnKeyboard(device, 'hello world', options(device, 1, { typoRate: 0 }));
    assert.equal(device.text, 'hello world');
    assert.equal(device.taps[0].label, 'shift', 'turns off auto-capitals first');
    assert.equal(report.typos, 0);
});

test('handles capitals, digits, punctuation, symbols and new lines', async () => {
    for (const seed of [2, 3, 4]) {
        const device = new FakeKeyboard();
        const text = "Hello World, it's 2024! OK? a+b=c #win\nBye.";
        await typeOnKeyboard(device, text, options(device, seed, { typoRate: 0 }));
        assert.equal(device.text, text);
    }
});

test('slips onto neighbouring keys but always corrects them', async () => {
    let typos = 0;
    for (const seed of [5, 6, 7, 8]) {
        const device = new FakeKeyboard();
        const text = 'the quick brown fox jumps over the lazy dog';
        const report = await typeOnKeyboard(device, text, options(device, seed, { typoRate: 0.25 }));
        assert.equal(device.text, text);
        typos += report.typos;
        if (report.typos) assert.ok(device.taps.some((tap) => tap.label === 'delete'));
    }
    assert.ok(typos > 0, 'some slips happened');
});

test('typing rhythm is human: varied gaps, near the requested speed', async () => {
    const device = new FakeKeyboard();
    const text = 'just checking how fast this types when nobody is watching';
    const report = await typeOnKeyboard(device, text, options(device, 9, { wpm: 36, typoRate: 0 }));
    assert.equal(device.text, text);
    const gaps = device.taps.slice(1).map((tap, index) => tap.t - device.taps[index].t);
    assert.ok(Math.min(...gaps) >= 70, `no machine-gun presses (min ${Math.min(...gaps)} ms)`);
    assert.ok(new Set(gaps).size > gaps.length * 0.7, 'gaps vary');
    assert.ok(report.wpm > 20 && report.wpm < 50, `effective speed ${report.wpm} WPM`);
});

test('refuses characters the keyboard does not have', async () => {
    const device = new FakeKeyboard();
    await assert.rejects(typeOnKeyboard(device, 'café', options(device, 10)), /Cannot type "é"/);
});

test('far keys take longer than near ones on average, and presses stay inside the key', () => {
    const random = seeded(11);
    const near: number[] = [];
    const far: number[] = [];
    for (let i = 0; i < 400; i += 1) {
        near.push(keyIntervalMs({ x: 20, y: 470 }, { x: 57, y: 470 }, 31.5, 36, random));
        far.push(keyIntervalMs({ x: 20, y: 470 }, { x: 355, y: 580 }, 31.5, 36, random));
    }
    const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
    assert.ok(mean(far) > mean(near) * 1.3);
    const rect = { x: 100, y: 500, width: 31.5, height: 42 };
    for (let i = 0; i < 400; i += 1) {
        const point = keyPressPoint(rect, random);
        assert.ok(point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height);
    }
});

test('the keyboard cache reads each layer once, then recognises it with one lookup', async () => {
    const cache: KeyboardLayerCache = { layers: [] };
    const text = 'Salut, 2 fois. Oui';
    for (const seed of [1, 2]) {
        const device = new FakeKeyboard();
        let fullReads = 0;
        const read = device.readKeyboard.bind(device);
        device.readKeyboard = async () => { fullReads += 1; return read(); };
        await typeOnKeyboard(cachedKeyboard(device, cache), text, options(device, seed, { typoRate: 0 }));
        assert.equal(device.text, text);
        // First time: one full read per layer met (upper, lower, numbers). Second time: none.
        assert.equal(fullReads, seed === 1 ? cache.layers.length : 0);
    }
    assert.equal(cache.layers.length, 3);
});

test('words go to the device as one tap sequence each, with the same result', async () => {
    class SequenceKeyboard extends FakeKeyboard {
        sequences = 0;
        async performSequence(actions: PointerAction[]): Promise<boolean> {
            this.sequences += 1;
            // Play each down..up as its own tap, keeping the pauses between them.
            let tap: PointerAction[] = [];
            for (const action of actions) {
                if (action.type === 'pause' && !tap.length) { this.clock += action.duration; continue; }
                tap.push(action);
                if (action.type === 'pointerUp') { await this.perform(tap); tap = []; }
            }
            return true;
        }
    }
    const device = new SequenceKeyboard();
    const text = 'Salut toi, on tape vite maintenant';
    await typeOnKeyboard(device, text, options(device, 7, { typoRate: 0 }));
    assert.equal(device.text, text);
    // About one request per word instead of one per key.
    assert.ok(device.sequences <= 8, `${device.sequences} sequences`);
    assert.ok(device.taps.length >= Array.from(text).length);
});

test('a device without tap sequences falls back to one tap per request', async () => {
    class OldWda extends FakeKeyboard {
        async performSequence(): Promise<boolean> { return false; }
    }
    const device = new OldWda();
    await typeOnKeyboard(device, 'Salut toi', options(device, 3, { typoRate: 0 }));
    assert.equal(device.text, 'Salut toi');
});
