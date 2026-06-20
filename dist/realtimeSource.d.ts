/**
 * AWN Realtime data source — connects to `rt2.ambientweather.net` over
 * socket.io and pushes sensor updates as they arrive from the station
 * (typically every ~30 seconds for indoor units, longer outdoors). This
 * is the opt-in alternative to the platform's default 2-minute REST
 * polling loop.
 *
 * The class only delivers VALUE updates by `uniqueId` (the stable
 * `${mac}-${sensorKey}` identifier). It deliberately doesn't know about
 * HomeKit, wrappers, or naming — the platform already has the wrappers
 * registered after the initial REST discovery, and the realtime path
 * is purely "push values into existing wrappers."
 *
 * Reconnect behavior: socket.io-client's built-in reconnection is
 * disabled in favor of our own bounded exponential backoff. The default
 * client gives up after a few attempts on certain errors; we want to
 * retry indefinitely (the network or AWN's endpoint could be down for
 * extended periods).
 */
import type { Logger } from 'homebridge';
export interface RealtimeUpdate {
    uniqueId: string;
    value: number;
    /**
     * HomeKit-aligned low/normal flag for the sensor's physical probe.
     * undefined = no battery reported for this probe; true = low;
     * false = normal. Polarity is already inverted from AWN's
     * 0=low/1=good convention at the realtime layer so the platform
     * doesn't need to know.
     */
    batteryLow?: boolean;
}
export type RealtimeUpdateHandler = (updates: RealtimeUpdate[]) => void;
export interface RealtimeOptions {
    applicationKey: string;
    apiKey: string;
    log: Logger;
    onUpdates: RealtimeUpdateHandler;
    /**
     * Optional filter for which sensor keys the realtime source emits.
     * Defaults to "any numeric value" — but in practice the platform
     * wrappers Map will drop any uniqueId it doesn't know about, so a
     * broad filter here costs nothing.
     */
    isSensorKey?: (key: string) => boolean;
}
export declare class RealtimeSource {
    private readonly opts;
    private socket;
    private reconnectTimer;
    private heartbeatTimer;
    private currentBackoff;
    private stopped;
    private updatesSinceHeartbeat;
    private hasEverConnected;
    private lastDisconnectWasClean;
    constructor(opts: RealtimeOptions);
    start(): void;
    stop(): void;
    private startHeartbeat;
    private connect;
    private scheduleReconnect;
    /**
     * Normalize whatever the WS server sends into a flat list of
     * (uniqueId, value) updates. The realtime endpoint can deliver
     * either a single device object (the typical `data` payload) or an
     * array of them (the `subscribed` initial state). Both shapes are
     * accepted; everything else is silently dropped.
     */
    private handleDevicePayload;
    private normalizeToDevices;
}
//# sourceMappingURL=realtimeSource.d.ts.map