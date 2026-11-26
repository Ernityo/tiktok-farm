import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

import type { PhoneFarmPlugin, TaskDefinition, TaskExecutionContext } from './plugin.js';
import type { JsonObject, JsonValue, ScheduleTiming } from './types.js';
import { accountNiches, nicheForAccount, nichesToJson, normalizeHandle, parseNiche, pruneNiches } from './tiktok/niche.js';
import {
    accountWarmups, pruneWarmups, WARMUP_PLAN, warmupDay, warmupPhase, warmupStartDate, warmupsToJson,
} from './tiktok/warmup.js';
import { dailyFeedShare, warmupRuns } from './tiktok/warmup-history.js';

export interface TikTokPluginConfiguration {
    doomscrollEntrypoint?: string;
    warmupEntrypoint?: string;
    postEntrypoint?: string;
    bundleId?: string;
}

type DoomscrollPayload = JsonObject & {
    durationMinutes: number;
    personality: 'skimmer' | 'casual' | 'engaged';
    likeEnabled: boolean;
    saveEnabled: boolean;
    account?: string;
};

type WarmupPayload = JsonObject & {
    account: string;
    durationMinutes: number;
    personality: 'skimmer' | 'casual' | 'engaged';
};

const WARMUP_TASK = { pluginId: 'com.git-agni.tiktok', taskType: 'warmup', taskVersion: 1 } as const;
const LOCAL_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

type PostMedia = JsonObject & {
    assetId: string;
    name: string;
    mimeType: string;
};

type PostPayload = JsonObject & {
    media: PostMedia[];
    destination: 'draft' | 'publish';
    account: string;
    caption?: string;
    musicUrl?: string;
    recurringPublishConfirmed?: boolean;
};

function objectPayload(value: JsonValue): Record<string, JsonValue> {
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Payload must be an object');
    return value;
}

function optionalString(value: JsonValue | undefined, name: string): string | undefined {
    if (value === undefined) return;
    if (typeof value !== 'string') throw new Error(`${name} must be a string`);
    return value;
}

function createDoomscrollTask(configuration: TikTokPluginConfiguration): TaskDefinition<DoomscrollPayload> {
    return {
        type: 'doomscroll', version: 1, displayName: 'TikTok doomscroll',
        validate(value) {
            const input = objectPayload(value);
            const durationMinutes = input.durationMinutes;
            const personality = input.personality;
            if (!Number.isInteger(durationMinutes) || typeof durationMinutes !== 'number' || durationMinutes < 1 || durationMinutes > 180) {
                throw new Error('durationMinutes must be between 1 and 180');
            }
            if (personality !== 'skimmer' && personality !== 'casual' && personality !== 'engaged') {
                throw new Error('Invalid personality');
            }
            if (typeof input.likeEnabled !== 'boolean' || typeof input.saveEnabled !== 'boolean') {
                throw new Error('Engagement settings must be boolean');
            }
            const account = optionalString(input.account, 'account');
            return {
                durationMinutes, personality, likeEnabled: input.likeEnabled, saveEnabled: input.saveEnabled,
                ...(account ? { account } : {}),
            };
        },
        summarize: (payload) => `Doomscroll · ${payload.personality} · ${payload.durationMinutes} min`,
        estimateDurationMs: (payload) => payload.durationMinutes * 60_000,
        retryPolicy: () => ({ retryLimit: 2, retryDelaySeconds: 60, retryBackoff: true }),
        supportsStop: () => true,
        execute: (context, payload) => context.runProcess({
            entrypoint: configuration.doomscrollEntrypoint ?? fileURLToPath(new URL('./tiktok/doomscroll.ts', import.meta.url)),
            env: {
                IOS_UDID: context.device.udid,
                TIKTOK_BUNDLE_ID: configuration.bundleId ?? 'com.zhiliaoapp.musically',
                DOOMSCROLL_DURATION_MINUTES: String(payload.durationMinutes),
                DOOMSCROLL_PERSONALITY: payload.personality,
                DOOMSCROLL_LIKE_ENABLED: String(payload.likeEnabled),
                DOOMSCROLL_SAVE_ENABLED: String(payload.saveEnabled),
                ...(payload.account ? { TIKTOK_SWITCH_ACCOUNT: payload.account } : {}),
            },
        }),
    };
}

/**
 * One agentic warm-up session (src/agent/warmup.ts): the account's warm-up
 * day picks the phase (persona, then niche with a daily search). Scheduled
 * three times a day per account from the device page.
 */
function createWarmupTask(configuration: TikTokPluginConfiguration): TaskDefinition<WarmupPayload> {
    return {
        type: 'warmup', version: 1, displayName: 'TikTok warm-up',
        validate(value) {
            const input = objectPayload(value);
            if (typeof input.account !== 'string' || !/^@?[A-Za-z0-9._]{1,64}$/.test(input.account.trim())) throw new Error('Choose a TikTok account');
            const durationMinutes = input.durationMinutes ?? 10;
            if (typeof durationMinutes !== 'number' || !Number.isInteger(durationMinutes) || durationMinutes < 3 || durationMinutes > 30) {
                throw new Error('durationMinutes must be between 3 and 30');
            }
            const personality = input.personality ?? 'casual';
            if (personality !== 'skimmer' && personality !== 'casual' && personality !== 'engaged') throw new Error('Invalid personality');
            return { account: normalizeHandle(input.account), durationMinutes, personality };
        },
        summarize: (payload) => `Warm-up · ${payload.account} · ${payload.durationMinutes} min`,
        // Sessions run up to 15% long, plus the account check and a search.
        estimateDurationMs: (payload) => Math.round(payload.durationMinutes * 60_000 * 1.15) + 60_000,
        retryPolicy: () => ({ retryLimit: 1, retryDelaySeconds: 120, retryBackoff: false }),
        supportsStop: () => true,
        execute: (context, payload) => context.runProcess({
            entrypoint: configuration.warmupEntrypoint ?? fileURLToPath(new URL('./agent/warmup.ts', import.meta.url)),
            env: {
                IOS_UDID: context.device.udid,
                TIKTOK_BUNDLE_ID: configuration.bundleId ?? 'com.zhiliaoapp.musically',
                WARMUP_ACCOUNT: payload.account,
                WARMUP_MINUTES: String(payload.durationMinutes),
                WARMUP_PERSONALITY: payload.personality,
            },
        }),
    };
}

function createPostTask(configuration: TikTokPluginConfiguration): TaskDefinition<PostPayload> {
    return {
        type: 'post', version: 1, displayName: 'TikTok post',
        validate(value, context) {
            const input = objectPayload(value);
            if (!Array.isArray(input.media) || input.media.length < 1 || input.media.length > 3) {
                throw new Error('Choose one to three media files');
            }
            const media = input.media.map((item) => {
                const candidate = objectPayload(item);
                if (typeof candidate.assetId !== 'string' || typeof candidate.name !== 'string' || typeof candidate.mimeType !== 'string') {
                    throw new Error('Invalid media item');
                }
                return { assetId: candidate.assetId, name: candidate.name, mimeType: candidate.mimeType };
            });
            if (input.destination !== 'draft' && input.destination !== 'publish') throw new Error('Invalid post destination');
            if (typeof input.account !== 'string' || !input.account.trim()) throw new Error('Choose a TikTok account');
            const caption = optionalString(input.caption, 'caption');
            if (caption && caption.length > 2200) throw new Error('Caption must be 2,200 characters or fewer');
            const musicUrl = optionalString(input.musicUrl, 'musicUrl');
            if (musicUrl) {
                const parsed = new URL(musicUrl);
                if (parsed.protocol !== 'https:' || !/(^|\.)tiktok\.com$/i.test(parsed.hostname)) {
                    throw new Error('Music URL must be an HTTPS TikTok URL');
                }
            }
            const recurring = context.timingKind === 'daily' || context.timingKind === 'weekly';
            if (recurring && input.destination === 'publish' && input.recurringPublishConfirmed !== true) {
                throw new Error('Recurring public posts require explicit confirmation');
            }
            return {
                media, destination: input.destination, account: input.account,
                ...(caption ? { caption } : {}), ...(musicUrl ? { musicUrl } : {}),
                ...(input.recurringPublishConfirmed === true ? { recurringPublishConfirmed: true } : {}),
            };
        },
        summarize: (payload) => `Post · ${payload.destination === 'publish' ? 'public' : 'draft'} · ${payload.media.length} media`,
        estimateDurationMs: () => 60_000,
        retryPolicy: () => ({ retryLimit: 0, retryDelaySeconds: 0, retryBackoff: false }),
        supportsStop: () => false,
        async execute(context: TaskExecutionContext, payload) {
            const byId = new Map(context.assets.map((asset) => [asset.id, asset]));
            const files = payload.media.map((media) => {
                const asset = byId.get(media.assetId);
                if (!asset) throw new Error(`Scheduled media asset ${media.assetId} is missing`);
                return { path: asset.path, name: media.name, mimeType: media.mimeType };
            });
            const manifestPath = path.join(context.workspaceDirectory, 'manifest.json');
            await writeFile(manifestPath, JSON.stringify({
                device: context.device, files, destination: payload.destination, account: payload.account,
                ...(payload.caption ? { caption: payload.caption } : {}),
                ...(payload.musicUrl ? { musicUrl: payload.musicUrl } : {}),
            }));
            return context.runProcess({
                entrypoint: configuration.postEntrypoint ?? fileURLToPath(new URL('./tiktok/post.ts', import.meta.url)),
                args: [manifestPath],
            });
        },
    };
}

export function createTikTokPlugin(configuration: TikTokPluginConfiguration = {}): PhoneFarmPlugin {
    return {
        id: 'com.git-agni.tiktok',
        version: '0.1.0',
        displayName: 'TikTok automation',
        tasks: [createDoomscrollTask(configuration), createPostTask(configuration), createWarmupTask(configuration)],
        devicePanels: [{
            id: 'tiktok-controls', title: 'TikTok',
            fragmentPath: fileURLToPath(new URL('../static/tiktok/device-panel.html', import.meta.url)), order: 100,
        }],
        async registerRoutes(context) {
            const deviceData = async (udid: string) => (await context.loadDevices()).find((device) => device.udid === udid);
            context.app.patch<{ Params: { udid: string }; Body: { accounts?: string[] } }>('/api/devices/:udid/accounts', async (request, reply) => {
                if (!Array.isArray(request.body.accounts)) return reply.code(400).send({ error: 'accounts must be an array' });
                const accounts = [...new Set(request.body.accounts.map((value) => value.trim()).filter(Boolean)
                    .map((value) => value.startsWith('@') ? value : `@${value}`))];
                if (accounts.some((value) => !/^@[A-Za-z0-9._]{1,64}$/.test(value))) {
                    return reply.code(400).send({ error: 'TikTok handles may contain letters, numbers, periods, and underscores' });
                }
                const found = await context.mutateDevices((devices) => {
                    const device = devices.find(({ udid }) => udid === request.params.udid);
                    if (!device) return false;
                    // A removed account takes its niche and warm-up with it.
                    const niches = nichesToJson(pruneNiches(accountNiches(device), accounts));
                    const warmups = warmupsToJson(pruneWarmups(accountWarmups(device), accounts));
                    device.pluginData = {
                        ...device.pluginData, 'com.git-agni.tiktok': { ...device.pluginData['com.git-agni.tiktok'], accounts, niches, warmups },
                    };
                    return true;
                });
                if (!found) return reply.code(404).send({ error: 'Device is not registered' });
                return { accounts };
            });

            // Sets (or, with `niche: null`, clears) the niche of one account
            // on this device. Agentic doomscroll reads it to judge each video.
            context.app.put<{ Params: { udid: string }; Body: { account?: unknown; niche?: unknown } }>(
                '/api/devices/:udid/tiktok/niches', async (request, reply) => {
                    const body = request.body ?? {};
                    if (typeof body.account !== 'string' || !body.account.trim()) return reply.code(400).send({ error: 'Choose an account' });
                    const account = normalizeHandle(body.account);
                    let niche: ReturnType<typeof parseNiche> | null = null;
                    if (body.niche !== null) {
                        try {
                            niche = parseNiche(body.niche as JsonValue);
                        } catch (error) {
                            return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
                        }
                    }
                    const outcome = await context.mutateDevices((devices) => {
                        const device = devices.find(({ udid }) => udid === request.params.udid);
                        if (!device) return 'missing-device' as const;
                        const settings = device.pluginData['com.git-agni.tiktok'] ?? {};
                        const accounts = Array.isArray(settings.accounts) ? settings.accounts.filter((value): value is string => typeof value === 'string') : [];
                        if (!accounts.map(normalizeHandle).includes(account)) return 'missing-account' as const;
                        const niches = accountNiches(device);
                        if (niche) niches[account] = niche;
                        else delete niches[account];
                        device.pluginData = { ...device.pluginData, 'com.git-agni.tiktok': { ...settings, niches: nichesToJson(niches) } };
                        return 'saved' as const;
                    });
                    if (outcome === 'missing-device') return reply.code(404).send({ error: 'Device is not registered' });
                    if (outcome === 'missing-account') return reply.code(400).send({ error: `${account} is not one of this device's TikTok accounts` });
                    return { account, niche };
                },
            );

            // The account's live warm-up schedules on this device.
            const warmupSchedules = async (udid: string, account: string) => (await context.scheduler.listSchedules(500, udid))
                .filter((row) => row.pluginId === WARMUP_TASK.pluginId && row.taskType === WARMUP_TASK.taskType
                    && (row.status === 'active' || row.status === 'paused')
                    && typeof row.payload.account === 'string' && normalizeHandle(row.payload.account) === account);
            const cancelSchedules = async (ids: readonly string[]) => {
                for (const id of ids) await context.scheduler.setScheduleStatus(id, 'cancelled').catch(() => undefined);
            };
            const saveWarmup = (udid: string, account: string, state: { startedOn: string; timezone: string } | null) => context.mutateDevices((devices) => {
                const device = devices.find((entry) => entry.udid === udid);
                if (!device) return;
                const warmups = accountWarmups(device);
                if (state) warmups[account] = state;
                else delete warmups[account];
                device.pluginData = { ...device.pluginData, 'com.git-agni.tiktok': { ...device.pluginData['com.git-agni.tiktok'], warmups: warmupsToJson(warmups) } };
            });

            // Warm-up status of every account on the device: day, phase, daily
            // sessions, and the For You on-niche share per niche-phase day.
            context.app.get<{ Params: { udid: string } }>('/api/devices/:udid/tiktok/warmup', async (request, reply) => {
                const device = await deviceData(request.params.udid);
                if (!device) return reply.code(404).send({ error: 'Device is not registered' });
                const accounts = await Promise.all(Object.entries(accountWarmups(device)).map(async ([account, state]) => {
                    const day = warmupDay(state);
                    const runs = await warmupRuns(device.udid, account, state);
                    return {
                        account, ...state, day, phase: warmupPhase(day), runs,
                        nicheShareByDay: dailyFeedShare(runs),
                        schedules: (await warmupSchedules(device.udid, account)).map((row) => ({ id: row.id, timing: row.timing, status: row.status })),
                    };
                }));
                return { plan: WARMUP_PLAN, accounts };
            });

            // Starts (or restarts from day 1) an account's warm-up: three daily
            // sessions at the given local times. Replaces its earlier warm-up schedules.
            context.app.put<{ Params: { udid: string }; Body: Record<string, unknown> }>('/api/devices/:udid/tiktok/warmup', async (request, reply) => {
                const device = await deviceData(request.params.udid);
                if (!device) return reply.code(404).send({ error: 'Device is not registered' });
                if (device.disabled) return reply.code(409).send({ error: 'This device is disconnected — reconnect it before scheduling automation' });
                const body = request.body ?? {};
                if (typeof body.account !== 'string' || !body.account.trim()) return reply.code(400).send({ error: 'Choose an account' });
                const account = normalizeHandle(body.account);
                const niche = nicheForAccount(device, account);
                if (!niche) return reply.code(400).send({ error: `Save a niche for ${account} first (Niches)` });
                if (!niche.persona) return reply.code(400).send({ error: `Add a persona to ${account}'s niche first: the first two days teach the feed who the person is` });
                const timezone = typeof body.timezone === 'string' ? body.timezone : 'UTC';
                const times = Array.isArray(body.times) ? body.times.filter((time): time is string => typeof time === 'string') : [];
                if (times.length !== 3 || times.some((time) => !LOCAL_TIME.test(time))) {
                    return reply.code(400).send({ error: 'Give three times of day (morning, noon, evening) as HH:MM' });
                }
                let startedOn: string;
                try {
                    startedOn = warmupStartDate(new Date(), timezone, times);
                } catch {
                    return reply.code(400).send({ error: 'Unknown timezone' });
                }
                const payload = {
                    account,
                    durationMinutes: body.durationMinutes === undefined ? 10 : Number(body.durationMinutes),
                    personality: typeof body.personality === 'string' ? body.personality : 'casual',
                };
                const previous = await warmupSchedules(device.udid, account);
                // Cancelled first, or they would clash with the new ones at the same times.
                await cancelSchedules(previous.map((row) => row.id));
                const created: string[] = [];
                try {
                    for (const localTime of times) {
                        const schedule = await context.scheduler.createTask({
                            deviceUdid: device.udid,
                            task: { ...WARMUP_TASK, payload },
                            timing: { kind: 'daily', localTime, timezone },
                            runWindowMinutes: body.runWindowMinutes === undefined ? 45 : Number(body.runWindowMinutes),
                        }, device.pluginData['com.git-agni.tiktok'] ?? {});
                        created.push(schedule.id);
                    }
                } catch (error) {
                    await cancelSchedules(created);
                    const message = error instanceof Error ? error.message : String(error);
                    return reply.code(400).send({
                        error: `${message}${previous.length ? ' (the earlier warm-up schedules were cancelled; start again with other times)' : ''}`,
                    });
                }
                await saveWarmup(device.udid, account, { startedOn, timezone });
                return { account, startedOn, timezone, schedules: created };
            });

            // Stops an account's warm-up: cancels its schedules and forgets its start day.
            context.app.delete<{ Params: { udid: string }; Querystring: { account?: string } }>('/api/devices/:udid/tiktok/warmup', async (request, reply) => {
                const device = await deviceData(request.params.udid);
                if (!device) return reply.code(404).send({ error: 'Device is not registered' });
                if (!request.query.account?.trim()) return reply.code(400).send({ error: 'Choose an account' });
                const account = normalizeHandle(request.query.account);
                const schedules = await warmupSchedules(device.udid, account);
                await cancelSchedules(schedules.map((row) => row.id));
                await saveWarmup(device.udid, account, null);
                return { account, cancelled: schedules.length };
            });

            context.app.post<{ Params: { udid: string }; Body: Record<string, string> }>(
                '/api/devices/:udid/fragments/scroll-run', async (request, reply) => {
                    const device = await deviceData(request.params.udid);
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
                                pluginId: 'com.git-agni.tiktok', taskType: 'doomscroll', taskVersion: 1,
                                payload: {
                                    durationMinutes: Number(body.durationMinutes), personality: body.personality,
                                    likeEnabled: body.likeEnabled === 'on', saveEnabled: body.saveEnabled === 'on',
                                    ...(body.account?.trim() ? { account: body.account.trim() } : {}),
                                },
                            },
                            timing,
                            runWindowMinutes: body.runWindowMinutes ? Number(body.runWindowMinutes) : undefined,
                        }, device.pluginData['com.git-agni.tiktok'] ?? {});
                        return reply.code(202).type('text/html').send(await context.renderActivity(device.udid));
                    } catch (error) {
                        return reply.type('text/html').send(await context.renderActivity(device.udid, error instanceof Error ? error.message : String(error)));
                    }
                },
            );

            context.app.get<{ Params: { udid: string } }>('/api/devices/:udid/posts/current', async (request) => {
                const latest = (await context.scheduler.listExecutions(25, request.params.udid))
                    .find(({ pluginId, taskType }) => pluginId === 'com.git-agni.tiktok' && taskType === 'post');
                if (!latest) return { status: 'idle', logs: [] };
                const detail = await context.scheduler.execution(latest.id);
                return { ...latest, destination: latest.payload.destination ?? null, logs: detail?.logs ?? [] };
            });

            context.app.post<{ Params: { udid: string } }>('/api/devices/:udid/posts', async (request, reply) => {
                const device = await deviceData(request.params.udid);
                if (!device) return reply.code(404).send({ error: 'Device is not registered' });
                if (device.disabled) return reply.code(409).send({ error: 'This device is disconnected — reconnect it before posting' });
                const dataRoot = path.resolve(process.env.SCHEDULER_DATA_DIR ?? '.scheduler-data');
                const assetRoot = path.join(dataRoot, 'assets');
                await mkdir(assetRoot, { recursive: true });
                const directory = await mkdtemp(path.join(assetRoot, 'post-'));
                const files: Array<{ path: string; name: string; mimeType: string }> = [];
                const fields = new Map<string, string>();
                let assetIds: string[] = [];
                try {
                    for await (const part of request.parts()) {
                        if (part.type === 'field') { fields.set(part.fieldname, String(part.value)); continue; }
                        if (part.fieldname !== 'media') continue;
                        const name = path.basename(part.filename || `upload-${files.length + 1}`).replace(/[^a-zA-Z0-9._-]/g, '_');
                        const filePath = path.join(directory, `${String(files.length).padStart(2, '0')}-${name}`);
                        await pipeline(part.file, createWriteStream(filePath, { flags: 'wx' }));
                        if (part.file.truncated) throw new Error(`${name} exceeds the upload limit`);
                        files.push({ path: filePath, name, mimeType: part.mimetype });
                    }
                    if (files.length < 1 || files.length > 3) throw new Error('Choose one to three media files');
                    const videos = files.filter(({ mimeType }) => mimeType.startsWith('video/'));
                    const images = files.filter(({ mimeType }) => mimeType.startsWith('image/'));
                    if (!((videos.length === 1 && files.length === 1) || images.length === files.length)) {
                        throw new Error('Upload exactly one video, or upload only slideshow images');
                    }
                    const destination = fields.get('destination');
                    if (destination !== 'draft' && destination !== 'publish') throw new Error('Choose Draft or Post');
                    const account = fields.get('account')?.trim();
                    if (!account) throw new Error('Choose a TikTok account');
                    const timing = fields.has('timing') ? JSON.parse(fields.get('timing')!) as ScheduleTiming : { kind: 'now' } as const;
                    const stored = await context.scheduler.registerAssets(await Promise.all(files.map(async (file) => ({
                        relativePath: path.relative(dataRoot, file.path), originalName: file.name, mimeType: file.mimeType,
                        size: (await stat(file.path)).size,
                        sha256: await new Promise<string>((resolve, reject) => {
                            const hash = crypto.createHash('sha256');
                            createReadStream(file.path).on('data', (chunk) => hash.update(chunk)).once('error', reject).once('end', () => resolve(hash.digest('hex')));
                        }),
                    }))));
                    assetIds = stored.map(({ id }) => id);
                    const schedule = await context.scheduler.createTask({
                        deviceUdid: device.udid,
                        task: {
                            pluginId: 'com.git-agni.tiktok', taskType: 'post', taskVersion: 1,
                            payload: {
                                media: stored.map(({ id, name, mimeType }) => ({ assetId: id, name, mimeType })),
                                destination, account,
                                ...(fields.get('caption')?.trim() ? { caption: fields.get('caption')!.trim() } : {}),
                                ...(fields.get('musicUrl')?.trim() ? { musicUrl: fields.get('musicUrl')!.trim() } : {}),
                                ...(fields.get('recurringPublishConfirmed') === 'true' ? { recurringPublishConfirmed: true } : {}),
                            },
                        },
                        timing,
                        runWindowMinutes: fields.get('runWindowMinutes') ? Number(fields.get('runWindowMinutes')) : undefined,
                    }, device.pluginData['com.git-agni.tiktok'] ?? {}, new Date(), assetIds);
                    return reply.code(202).send(schedule);
                } catch (error) {
                    if (assetIds.length) await context.scheduler.deleteAssets(assetIds);
                    await rm(directory, { recursive: true, force: true });
                    return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
                }
            });
        },
    };
}
