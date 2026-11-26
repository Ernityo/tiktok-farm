import { inject } from './support.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { PluginRegistry } from '../src/registry.js';
import type { SchedulerRepository } from '../src/scheduler/repository.js';

// registry.ts resolves DEVICES_CONFIG_PATH at first import, so set it before any import of it.
const configPath = path.join(await mkdtemp(path.join(os.tmpdir(), 'pf-ports-')), 'devices.json');
process.env.DEVICES_CONFIG_PATH = configPath;
delete process.env.WDA_REMOTE_PORT;
delete process.env.MJPEG_REMOTE_PORT;

const { allocatePhonePorts, validatePhonePorts, PHONE_PORT_RANGE } = await import('../src/devices/registry.js');

const phone = (udid: string, ports: { wdaRemotePort?: number; mjpegRemotePort?: number } = {}) =>
    ({ name: udid, udid, pluginData: {}, ...ports });

test('in-phone ports must be unique across phones; Mac-side ports are not checked', () => {
    validatePhonePorts([
        { ...phone('a', { wdaRemotePort: 21480, mjpegRemotePort: 21481 }), wdaLocalPort: 8100 },
        { ...phone('b', { wdaRemotePort: 21490, mjpegRemotePort: 21491 }), wdaLocalPort: 8100 },
    ]);
    assert.throws(() => validatePhonePorts([
        phone('a', { wdaRemotePort: 21480, mjpegRemotePort: 21481 }),
        phone('b', { wdaRemotePort: 21481, mjpegRemotePort: 21482 }),
    ]), /21481 is used by both a and b/);
    // Two phones with nothing set would both fall back to 8100.
    assert.throws(() => validatePhonePorts([phone('a'), phone('b')]), /8100/);
    assert.throws(() => validatePhonePorts([phone('a', { wdaRemotePort: 21480, mjpegRemotePort: 21480 })]), /must differ/);
    assert.throws(() => validatePhonePorts([phone('a', { wdaRemotePort: 80, mjpegRemotePort: 21481 })]), /1024 to 65535/);
});

test('allocatePhonePorts picks a free adjacent pair inside the range', () => {
    const pair = allocatePhonePorts([phone('a', { wdaRemotePort: 21480, mjpegRemotePort: 21481 })]);
    assert.equal(pair.mjpegRemotePort, pair.wdaRemotePort + 1);
    assert.ok(pair.wdaRemotePort >= PHONE_PORT_RANGE.min && pair.mjpegRemotePort <= PHONE_PORT_RANGE.max);

    // A random source that first lands on a taken port must move on to a free one.
    const draws = [ (21481 - PHONE_PORT_RANGE.min) / 11999, (25000 - PHONE_PORT_RANGE.min) / 11999 ];
    const next = allocatePhonePorts([phone('a', { wdaRemotePort: 21480, mjpegRemotePort: 21481 })], [], () => draws.shift()!);
    assert.deepEqual(next, { wdaRemotePort: 25000, mjpegRemotePort: 25001 });
});

test('the device API saves in-phone ports and rejects a clash with another phone', async (context) => {
    await writeFile(configPath, JSON.stringify([
        phone('udid-1', { wdaRemotePort: 21480, mjpegRemotePort: 21481 }),
        phone('udid-2', { wdaRemotePort: 23000, mjpegRemotePort: 23001 }),
    ]));
    const scheduler = { async activeExecution() { return null; }, async listSchedules() { return []; } } as unknown as SchedulerRepository;
    const { createApp } = await import('../src/api/app.js');
    const app = await createApp({ plugins: new PluginRegistry([]), scheduler });
    context.after(() => app.close());
    const patch = (payload: object) => inject(app, {
        method: 'PATCH', url: '/api/devices/udid-2', payload, headers: { 'content-type': 'application/json' },
    });

    const clash = await patch({ wdaRemotePort: 21481, mjpegRemotePort: 21482 });
    assert.equal(clash.statusCode, 400);
    assert.match(clash.json().error, /21481/);

    const ok = await patch({ wdaRemotePort: 24000, mjpegRemotePort: 24001 });
    assert.equal(ok.statusCode, 200);
    const saved = JSON.parse(await readFile(configPath, 'utf8')) as Array<{ udid: string; wdaRemotePort?: number }>;
    assert.equal(saved.find(({ udid }) => udid === 'udid-2')!.wdaRemotePort, 24000);
});
