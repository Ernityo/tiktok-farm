import assert from 'node:assert/strict';
import test from 'node:test';

import { PluginRegistry } from '../src/registry.js';
import { createFacebookPlugin } from '../src/facebook-plugin.js';
import { createTikTokPlugin } from '../src/tiktok-plugin.js';

const plugin = createFacebookPlugin({ reelsDoomscrollEntrypoint: '/example/reels.js' });
const request = (payload: Record<string, unknown>) => ({
    deviceUdid: 'device-12345678',
    task: { pluginId: plugin.id, taskType: 'reels-doomscroll', taskVersion: 1, payload },
    timing: { kind: 'now' as const },
});

test('Facebook plugin validates Reels doomscroll tasks', () => {
    const registry = new PluginRegistry([plugin]);
    const value = registry.validate(request({ durationMinutes: 10, personality: 'engaged', likeEnabled: true, extra: 1 }) as never);
    assert.deepEqual(value.task.payload, { durationMinutes: 10, personality: 'engaged', likeEnabled: true });
});

test('Facebook Reels doomscroll rejects bad payloads', () => {
    const registry = new PluginRegistry([plugin]);
    assert.throws(() => registry.validate(request({ durationMinutes: 0, personality: 'casual', likeEnabled: true }) as never), /durationMinutes/);
    assert.throws(() => registry.validate(request({ durationMinutes: 181, personality: 'casual', likeEnabled: true }) as never), /durationMinutes/);
    assert.throws(() => registry.validate(request({ durationMinutes: 5, personality: 'bored', likeEnabled: true }) as never), /personality/);
    assert.throws(() => registry.validate(request({ durationMinutes: 5, personality: 'casual', likeEnabled: 'yes' }) as never), /likeEnabled/);
});

test('Facebook and TikTok plugins load side by side', () => {
    const registry = new PluginRegistry([createTikTokPlugin(), plugin]);
    assert.ok(registry.validate(request({ durationMinutes: 5, personality: 'casual', likeEnabled: false }) as never));
});
