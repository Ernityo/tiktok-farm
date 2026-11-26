import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { coordinatesForProfile, validateCoordinateOverrides, type DeviceCoordinateOverrides, type DeviceProfileName } from './coordinates.js';
import type { JsonObject } from '../types.js';

export interface RegisteredDevice {
    name: string;
    udid: string;
    coordinateProfile?: DeviceProfileName;
    wdaLocalPort?: number;
    mjpegLocalPort?: number;
    /** Port WDA listens on inside the phone (USE_PORT); defaults to WDA_REMOTE_PORT or 8100. */
    wdaRemotePort?: number;
    /** MJPEG port inside the phone (MJPEG_SERVER_PORT); defaults to MJPEG_REMOTE_PORT or 9100. */
    mjpegRemotePort?: number;
    /** Device unlock passcode. Lives here (devices.json is 0600 and git-ignored), never in an API response. */
    passcode?: string;
    /** Per-device single-tap coordinate overrides (dashboard calibration). */
    coordinates?: DeviceCoordinateOverrides;
    /** When true the farm keeps the entry but stops supervising it — no WDA, no worker, no discovery polling. */
    disabled?: boolean;
    pluginData: Record<string, JsonObject>;
}

/** Devices the farm should actively supervise (everything except the disabled ones). */
export function activeDevices(devices: readonly RegisteredDevice[]): RegisteredDevice[] {
    return devices.filter((device) => !device.disabled);
}

export const PASSCODE_PATTERN = /^\d{4,}$/;

/** Range new phones draw their in-phone WDA/MJPEG ports from: no well-known services live here. */
export const PHONE_PORT_RANGE = { min: 20000, max: 31999 } as const;

/** The ports WDA and its MJPEG stream listen on inside the phone, after env/default fallbacks. */
export function phonePorts(device: Pick<RegisteredDevice, 'wdaRemotePort' | 'mjpegRemotePort'>): { wda: number; mjpeg: number } {
    return {
        wda: device.wdaRemotePort ?? Number(process.env.WDA_REMOTE_PORT ?? 8100),
        mjpeg: device.mjpegRemotePort ?? Number(process.env.MJPEG_REMOTE_PORT ?? 9100),
    };
}

/**
 * Throws unless every device's in-phone ports are valid and no two devices share one.
 * Mac-side (local) ports are deliberately not checked here.
 */
export function validatePhonePorts(devices: readonly RegisteredDevice[]): void {
    const owners = new Map<number, string>();
    for (const device of devices) {
        const { wda, mjpeg } = phonePorts(device);
        for (const port of [wda, mjpeg]) {
            if (!Number.isInteger(port) || port < 1024 || port > 65535) {
                throw new Error(`${device.name || device.udid}: in-phone port ${port} must be a whole number from 1024 to 65535`);
            }
        }
        if (wda === mjpeg) throw new Error(`${device.name || device.udid}: the WDA and video ports inside the phone must differ`);
        for (const port of [wda, mjpeg]) {
            const owner = owners.get(port);
            if (owner) {
                throw new Error(`In-phone port ${port} is used by both ${owner} and ${device.name || device.udid}; give each phone its own ports (device page → Ports)`);
            }
            owners.set(port, device.name || device.udid);
        }
    }
}

/** Picks an adjacent WDA/MJPEG pair in PHONE_PORT_RANGE that no listed device (or reservation) uses. */
export function allocatePhonePorts(
    devices: readonly RegisteredDevice[],
    reserved: ReadonlyArray<{ wdaRemotePort?: number; mjpegRemotePort?: number }> = [],
    random: () => number = Math.random,
): { wdaRemotePort: number; mjpegRemotePort: number } {
    const used = new Set<number>();
    for (const device of devices) {
        const { wda, mjpeg } = phonePorts(device);
        used.add(wda).add(mjpeg);
    }
    for (const pair of reserved) {
        if (pair.wdaRemotePort !== undefined) used.add(pair.wdaRemotePort);
        if (pair.mjpegRemotePort !== undefined) used.add(pair.mjpegRemotePort);
    }
    const span = PHONE_PORT_RANGE.max - PHONE_PORT_RANGE.min; // last start leaves room for +1
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
        const wdaRemotePort = PHONE_PORT_RANGE.min + Math.floor(random() * span);
        if (!used.has(wdaRemotePort) && !used.has(wdaRemotePort + 1)) {
            return { wdaRemotePort, mjpegRemotePort: wdaRemotePort + 1 };
        }
    }
    throw new Error('No free in-phone port pair is available');
}

/** A device with its passcode removed and a boolean marker in its place — safe to serialize. */
export function redactDevice<T extends { passcode?: string }>(device: T): Omit<T, 'passcode'> & { hasPasscode: boolean } {
    const { passcode, ...rest } = device;
    return { ...rest, hasPasscode: Boolean(passcode) };
}

const defaultRegistryPath = path.resolve(process.env.DEVICES_CONFIG_PATH ?? 'devices.json');

export async function loadRegisteredDevices(registryPath = defaultRegistryPath): Promise<RegisteredDevice[]> {
    let raw: string;
    try {
        raw = await readFile(registryPath, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }
    let devices: RegisteredDevice[];
    try {
        devices = JSON.parse(raw) as RegisteredDevice[];
    } catch (error) {
        throw new Error(`${registryPath} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const device of devices) {
        coordinatesForProfile(device.coordinateProfile);
        device.pluginData ??= {};
    }
    return devices;
}

export async function saveRegisteredDevices(devices: RegisteredDevice[], registryPath = defaultRegistryPath): Promise<void> {
    const unique = new Set<string>();
    for (const device of devices) {
        coordinatesForProfile(device.coordinateProfile);
        if (device.passcode !== undefined && !PASSCODE_PATTERN.test(device.passcode)) {
            throw new Error(`Device ${device.udid} passcode must contain at least four digits`);
        }
        if (device.coordinates !== undefined) {
            device.coordinates = validateCoordinateOverrides(device.coordinates, device.coordinateProfile);
            if (Object.keys(device.coordinates).length === 0) delete device.coordinates;
        }
        if (device.disabled !== true) delete device.disabled;
        if (unique.has(device.udid)) throw new Error(`Device ${device.udid} is already registered`);
        unique.add(device.udid);
    }
    validatePhonePorts(devices);
    await mkdir(path.dirname(registryPath), { recursive: true });
    const temporaryPath = `${registryPath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(devices, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, registryPath);
}

// Every load-modify-save of devices.json in one process must go through here,
// or two overlapping mutations (a passcode save racing a disable toggle) each
// read the same file and the second write clobbers the first.
let registryMutation: Promise<unknown> = Promise.resolve();

export function mutateRegisteredDevices<T>(
    mutate: (devices: RegisteredDevice[]) => T | Promise<T>,
    registryPath = defaultRegistryPath,
): Promise<T> {
    const run = registryMutation.then(async () => {
        const devices = await loadRegisteredDevices(registryPath);
        const result = await mutate(devices);
        await saveRegisteredDevices(devices, registryPath);
        return result;
    });
    registryMutation = run.catch(() => undefined);
    return run;
}
