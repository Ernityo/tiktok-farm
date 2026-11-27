import assert from 'node:assert/strict';
import test from 'node:test';

import { WdaRemoteControl } from '../src/devices/wda-remote.js';

function streamingResponse(): Response {
    const body = new ReadableStream<Uint8Array>({ start() { /* never ends */ } });
    return new Response(body, { status: 200, headers: { 'content-type': 'multipart/x-mixed-replace; boundary=x' } });
}

test('getMjpegStream ties the upstream fetch to the caller signal', async () => {
    let seenSignal: AbortSignal | undefined;
    const remote = new WdaRemoteControl({
        deviceUdid: 'udid-1',
        mjpegUrl: 'http://127.0.0.1:9100',
        fetchImpl: (async (_url: string, init?: RequestInit) => {
            seenSignal = init?.signal ?? undefined;
            return streamingResponse();
        }) as typeof fetch,
    });

    const client = new AbortController();
    const response = await remote.getMjpegStream('udid-1', client.signal);
    assert.ok(response.body, 'stream body is returned');
    assert.ok(seenSignal, 'fetch received an abort signal');
    assert.equal(seenSignal!.aborted, false);

    client.abort();
    assert.equal(seenSignal!.aborted, true, 'aborting the client signal aborts the upstream fetch');
});

test('getMjpegStream still works without a caller signal', async () => {
    const remote = new WdaRemoteControl({
        deviceUdid: 'udid-1', mjpegUrl: 'http://127.0.0.1:9100',
        fetchImpl: (async () => streamingResponse()) as typeof fetch,
    });
    const response = await remote.getMjpegStream('udid-1');
    assert.equal(response.status, 200);
});

function frameResponse(chunks: Uint8Array[], onCancel?: () => void): Response {
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (index < chunks.length) controller.enqueue(chunks[index++]!);
            // then hang, like a live stream
        },
        cancel() { onCancel?.(); },
    });
    return new Response(body, { status: 200 });
}

function part(jpeg: Buffer): Buffer {
    return Buffer.concat([
        Buffer.from(`--BoundaryString\r\nContent-type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`),
        jpeg,
        Buffer.from('\r\n\r\n'),
    ]);
}

test('getStreamFrame returns the first frame across split chunks and closes the stream', async () => {
    const first = Buffer.from([0xff, 0xd8, 1, 2, 3, 4, 5, 0xff, 0xd9]);
    const second = Buffer.from([0xff, 0xd8, 9, 9, 0xff, 0xd9]);
    const bytes = Buffer.concat([part(first), part(second)]);
    // Split inside the header and inside the image.
    const chunks = [bytes.subarray(0, 10), bytes.subarray(10, 60), bytes.subarray(60, 63), bytes.subarray(63)];
    let signal: AbortSignal | undefined;
    const remote = new WdaRemoteControl({
        deviceUdid: 'udid-1', mjpegUrl: 'http://127.0.0.1:9100',
        fetchImpl: (async (_url: string, init?: RequestInit) => {
            signal = init?.signal ?? undefined;
            return frameResponse(chunks);
        }) as typeof fetch,
    });
    const frame = await remote.getStreamFrame('udid-1', 1000);
    assert.deepEqual(frame, first);
    assert.equal(signal?.aborted, true, 'the connection is closed after the frame');
});

test('getStreamFrame times out when no frame comes', async () => {
    const remote = new WdaRemoteControl({
        deviceUdid: 'udid-1', mjpegUrl: 'http://127.0.0.1:9100',
        fetchImpl: (async (_url: string, init?: RequestInit) => {
            const body = new ReadableStream<Uint8Array>({
                start(controller) { init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason)); },
            });
            return new Response(body, { status: 200 });
        }) as typeof fetch,
    });
    await assert.rejects(remote.getStreamFrame('udid-1', 50), /No MJPEG frame within 50 ms/);
});
