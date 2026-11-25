import assert from 'node:assert/strict';
import test from 'node:test';

import { TouchEventHub, emitTouch, parseTouchEventMessage, type TouchEventMessage } from '../src/devices/touch-events.js';

test('parseTouchEventMessage accepts taps and swipes and rejects junk', () => {
    assert.deepEqual(parseTouchEventMessage(JSON.stringify({ udid: 'u1', source: 'automation', at: 5, touch: { type: 'tap', x: 10, y: 20 } })),
        { udid: 'u1', source: 'automation', at: 5, touch: { type: 'tap', x: 10, y: 20 } });
    const swipe = parseTouchEventMessage(JSON.stringify({ udid: 'u1', touch: { type: 'swipe', startX: 1, startY: 2, endX: 3, endY: 4, durationMs: 300 } }));
    assert.equal(swipe?.touch.type, 'swipe');
    assert.equal(swipe?.source, 'automation');
    assert.equal(parseTouchEventMessage('not json'), undefined);
    assert.equal(parseTouchEventMessage(JSON.stringify({ udid: 'u1', touch: { type: 'tap', x: 'a', y: 1 } })), undefined);
    assert.equal(parseTouchEventMessage(JSON.stringify({ touch: { type: 'tap', x: 1, y: 1 } })), undefined);
});

test('emitTouch datagrams reach TouchEventHub subscribers for that device only', async () => {
    const port = 40000 + Math.floor(Math.random() * 10000);
    process.env.TOUCH_EVENTS_PORT = String(port);
    const hub = new TouchEventHub();
    await hub.start(port);
    try {
        const other: TouchEventMessage[] = [];
        hub.subscribe('other', (message) => other.push(message));
        const received = new Promise<TouchEventMessage>((resolve) => {
            const unsubscribe = hub.subscribe('u1', (message) => { unsubscribe(); resolve(message); });
        });
        emitTouch({ type: 'tap', x: 100, y: 200 }, { udid: 'u1' });
        const message = await received;
        assert.deepEqual(message.touch, { type: 'tap', x: 100, y: 200 });
        assert.equal(message.source, 'automation');
        assert.equal(other.length, 0);
    } finally {
        await hub.close();
        delete process.env.TOUCH_EVENTS_PORT;
    }
});
