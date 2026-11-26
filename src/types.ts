export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface DeviceIdentity {
    udid: string;
    name: string;
    osVersion?: string;
    productType?: string;
}

export interface RegisteredDevice extends DeviceIdentity {
    wdaLocalPort?: number;
    mjpegLocalPort?: number;
    /** Port WDA listens on inside the phone (USE_PORT); defaults to WDA_REMOTE_PORT or 8100. */
    wdaRemotePort?: number;
    /** MJPEG port inside the phone (MJPEG_SERVER_PORT); defaults to MJPEG_REMOTE_PORT or 9100. */
    mjpegRemotePort?: number;
    /** Compiled tap-layout key; canonical here, not in pluginData. */
    coordinateProfile?: string;
    passcode?: string;
    coordinates?: Record<string, { x: number; y: number }>;
    disabled?: boolean;
    pluginData: Record<string, JsonObject>;
}

export type ScheduleTiming =
    | { kind: 'now' }
    | { kind: 'once'; runAt: string }
    | { kind: 'daily'; localTime: string; timezone: string }
    | { kind: 'weekly'; localTime: string; timezone: string; weekdays: number[] };

export interface TaskEnvelope<TPayload extends JsonObject = JsonObject> {
    pluginId: string;
    taskType: string;
    taskVersion: number;
    payload: TPayload;
}

export interface CreateTaskInput<TPayload extends JsonObject = JsonObject> {
    deviceUdid: string;
    task: TaskEnvelope<TPayload>;
    timing: ScheduleTiming;
    runWindowMinutes?: number;
}

export interface StoredAsset {
    id: string;
    path: string;
    name: string;
    mimeType: string;
    size: number;
    sha256: string;
}

export interface TaskExecutionResult {
    exitCode: number | null;
    stopped: boolean;
    error?: string;
}

export interface TaskRetryPolicy {
    retryLimit: number;
    retryDelaySeconds: number;
    retryBackoff: boolean;
}
