import { fileURLToPath } from 'node:url';

import type { PhoneFarmPlugin, TaskDefinition } from './plugin.js';
import type { JsonObject, JsonValue, ScheduleTiming } from './types.js';

export const FACEBOOK_PLUGIN_ID = 'com.git-agni.facebook';

export interface FacebookPluginConfiguration {
    reelsDoomscrollEntrypoint?: string;
    bundleId?: string;
}

type ReelsDoomscrollPayload = JsonObject & {
    durationMinutes: number;
    personality: 'skimmer' | 'casual' | 'engaged';
    likeEnabled: boolean;
    fullWatchPercent: number;
};

/** Used when a payload predates the setting. */
export const DEFAULT_FULL_WATCH_PERCENT = 20;

function objectPayload(value: JsonValue): Record<string, JsonValue> {
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Payload must be an object');
    return value;
}

function createReelsDoomscrollTask(configuration: FacebookPluginConfiguration): TaskDefinition<ReelsDoomscrollPayload> {
    return {
        type: 'reels-doomscroll', version: 1, displayName: 'Facebook Reels doomscroll',
        validate(value) {
            const input = objectPayload(value);
            const { durationMinutes, personality, likeEnabled } = input;
            const fullWatchPercent = input.fullWatchPercent ?? DEFAULT_FULL_WATCH_PERCENT;
            if (typeof durationMinutes !== 'number' || !Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 180) {
                throw new Error('durationMinutes must be between 1 and 180');
            }
            if (personality !== 'skimmer' && personality !== 'casual' && personality !== 'engaged') {
                throw new Error('Invalid personality');
            }
            if (typeof likeEnabled !== 'boolean') throw new Error('likeEnabled must be boolean');
            if (typeof fullWatchPercent !== 'number' || !Number.isInteger(fullWatchPercent) || fullWatchPercent < 0 || fullWatchPercent > 100) {
                throw new Error('fullWatchPercent must be between 0 and 100');
            }
            return { durationMinutes, personality, likeEnabled, fullWatchPercent };
        },
        summarize: (payload) => `Facebook Reels · ${payload.personality} · ${payload.durationMinutes} min`,
        estimateDurationMs: (payload) => payload.durationMinutes * 60_000,
        retryPolicy: () => ({ retryLimit: 2, retryDelaySeconds: 60, retryBackoff: true }),
        supportsStop: () => true,
        execute: (context, payload) => context.runProcess({
            entrypoint: configuration.reelsDoomscrollEntrypoint
                ?? fileURLToPath(new URL('./facebook/reels-doomscroll.ts', import.meta.url)),
            env: {
                IOS_UDID: context.device.udid,
                FACEBOOK_BUNDLE_ID: configuration.bundleId ?? 'com.facebook.Facebook',
                DOOMSCROLL_DURATION_MINUTES: String(payload.durationMinutes),
                DOOMSCROLL_PERSONALITY: payload.personality,
                DOOMSCROLL_LIKE_ENABLED: String(payload.likeEnabled),
                DOOMSCROLL_FULL_WATCH_PERCENT: String(payload.fullWatchPercent),
            },
        }),
    };
}

export function createFacebookPlugin(configuration: FacebookPluginConfiguration = {}): PhoneFarmPlugin {
    return {
        id: FACEBOOK_PLUGIN_ID,
        version: '0.1.0',
        displayName: 'Facebook automation',
        tasks: [createReelsDoomscrollTask(configuration)],
        devicePanels: [{
            id: 'facebook-controls', title: 'Facebook',
            fragmentPath: fileURLToPath(new URL('../static/facebook/device-panel.html', import.meta.url)), order: 110,
        }],
        async registerRoutes(context) {
            // Form target of the "Reels doomscroll" dialog on the dashboard's
            // device page; answers with the refreshed activity panel.
            context.app.post<{ Params: { udid: string }; Body: Record<string, string> }>(
                '/api/devices/:udid/fragments/facebook-reels-run', async (request, reply) => {
                    const device = (await context.loadDevices()).find(({ udid }) => udid === request.params.udid);
                    if (!device) return reply.code(404).send({ error: 'Device is not registered' });
                    if (device.disabled) return reply.code(409).send({ error: 'This device is disconnected — reconnect it before scheduling automation' });
                    const body = request.body;
                    const kind = body.scheduleKind ?? 'now';
                    const timing: ScheduleTiming = kind === 'now' ? { kind: 'now' }
                        : kind === 'once' ? { kind: 'once', runAt: body.runAt ?? '' }
                            : kind === 'daily' ? { kind: 'daily', localTime: body.localTime ?? '', timezone: body.timezone ?? 'UTC' }
                                : { kind: 'weekly', localTime: body.localTime ?? '', timezone: body.timezone ?? 'UTC', weekdays: (body.weekdays ?? '').split(',').filter(Boolean).map(Number) };
                    try {
                        await context.scheduler.createTask({
                            deviceUdid: device.udid,
                            task: {
                                pluginId: FACEBOOK_PLUGIN_ID, taskType: 'reels-doomscroll', taskVersion: 1,
                                payload: {
                                    durationMinutes: Number(body.durationMinutes), personality: body.personality ?? '',
                                    likeEnabled: body.likeEnabled === 'on',
                                    ...(body.fullWatchPercent ? { fullWatchPercent: Number(body.fullWatchPercent) } : {}),
                                },
                            },
                            timing,
                            runWindowMinutes: body.runWindowMinutes ? Number(body.runWindowMinutes) : undefined,
                        }, device.pluginData[FACEBOOK_PLUGIN_ID] ?? {});
                        return reply.code(202).type('text/html').send(await context.renderActivity(device.udid));
                    } catch (error) {
                        return reply.type('text/html').send(await context.renderActivity(device.udid, error instanceof Error ? error.message : String(error)));
                    }
                },
            );
        },
    };
}
