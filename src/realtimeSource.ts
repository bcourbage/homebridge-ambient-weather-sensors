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

import { io, Socket } from 'socket.io-client';
import type { Logger } from 'homebridge';

export interface RealtimeUpdate {
  uniqueId: string;
  value: number;
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

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

// How often the realtime source checks whether the subscription is
// still delivering data. The healthy case logs at debug level (silent
// during normal operation); a heartbeat that observed zero updates is
// surfaced at warn level since it points at a real anomaly (socket
// alive but no data flowing). 5 minutes is short enough that a stalled
// subscription is visible within a few cycles without spamming the log.
const HEARTBEAT_INTERVAL_MS = 5 * 60_000;

export class RealtimeSource {
  private socket: Socket | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private currentBackoff = INITIAL_BACKOFF_MS;
  private stopped = false;
  // Counter of data events received since the last heartbeat log so the
  // user can see at a glance whether the subscription is actually
  // delivering updates.
  private updatesSinceHeartbeat = 0;

  constructor(private readonly opts: RealtimeOptions) {}

  start(): void {
    this.stopped = false;
    this.connect();
    this.startHeartbeat();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = undefined;
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) {
      return;
    }
    this.heartbeatTimer = setInterval(() => {
      const minutes = Math.round(HEARTBEAT_INTERVAL_MS / 60_000);
      const count = this.updatesSinceHeartbeat;
      this.updatesSinceHeartbeat = 0;
      if (count === 0) {
        // No data over a full heartbeat window — the socket is probably
        // still connected (otherwise our disconnect handler would have
        // fired) but AWN has stopped pushing updates. Surface at warn so
        // it shows up at default log verbosity; healthy heartbeats stay
        // at debug so they don't clutter the log.
        this.opts.log.warn(`Realtime: 0 updates received in the last ${minutes} minutes; subscription may be stalled`);
      } else {
        this.opts.log.debug(`Realtime: ${count} updates received in the last ${minutes} minutes`);
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private connect(): void {
    if (this.stopped) {
      return;
    }

    // applicationKey goes in the URL query (per AWN's realtime API
    // contract); apiKey is sent later via the `subscribe` event.
    const url = `https://rt2.ambientweather.net/?api=1&applicationKey=${encodeURIComponent(this.opts.applicationKey)}`;

    this.opts.log.info('Realtime: connecting to AWN websocket');

    this.socket = io(url, {
      transports: ['websocket'],
      reconnection: false, // we handle reconnect ourselves
    });

    this.socket.on('connect', () => {
      this.opts.log.info(`Realtime: connected (sid=${this.socket?.id ?? '?'})`);
      this.currentBackoff = INITIAL_BACKOFF_MS;
      this.socket?.emit('subscribe', { apiKeys: [this.opts.apiKey] });
    });

    this.socket.on('subscribed', (payload: unknown) => {
      this.opts.log.info('Realtime: subscription confirmed by AWN');
      this.handleDevicePayload(payload);
    });

    this.socket.on('data', (payload: unknown) => {
      this.opts.log.debug('Realtime: data event received');
      this.updatesSinceHeartbeat += 1;
      this.handleDevicePayload(payload);
    });

    this.socket.on('disconnect', (reason: string) => {
      this.opts.log.warn(`Realtime: disconnected (${reason})`);
      this.scheduleReconnect();
    });

    this.socket.on('connect_error', (error: Error) => {
      this.opts.log.error('Realtime: connection error:', error.message);
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) {
      return;
    }
    if (this.reconnectTimer) {
      return; // already scheduled
    }
    const delay = this.currentBackoff;
    this.opts.log.info(`Realtime: scheduling reconnect in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
    this.currentBackoff = Math.min(this.currentBackoff * 2, MAX_BACKOFF_MS);
  }

  /**
   * Normalize whatever the WS server sends into a flat list of
   * (uniqueId, value) updates. The realtime endpoint can deliver
   * either a single device object (the typical `data` payload) or an
   * array of them (the `subscribed` initial state). Both shapes are
   * accepted; everything else is silently dropped.
   */
  private handleDevicePayload(payload: unknown): void {
    const devices = this.normalizeToDevices(payload);
    const updates: RealtimeUpdate[] = [];

    for (const dev of devices) {
      const macAddress = dev.macAddress;
      if (typeof macAddress !== 'string') {
        continue;
      }

      // `subscribed` payload wraps sensor values in `lastData`. `data`
      // events deliver them flat at the top level. Accept both.
      const lastData = (dev as { lastData?: Record<string, unknown> }).lastData ?? (dev as Record<string, unknown>);
      if (!lastData || typeof lastData !== 'object') {
        continue;
      }

      for (const [key, value] of Object.entries(lastData)) {
        if (typeof value !== 'number') {
          continue;
        }
        if (this.opts.isSensorKey && !this.opts.isSensorKey(key)) {
          continue;
        }
        updates.push({
          uniqueId: `${macAddress}-${key}`,
          value,
        });
      }
    }

    if (updates.length > 0) {
      this.opts.onUpdates(updates);
    }
  }

  private normalizeToDevices(payload: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(payload)) {
      return payload as Array<Record<string, unknown>>;
    }
    if (payload && typeof payload === 'object') {
      const obj = payload as Record<string, unknown>;
      if (Array.isArray(obj.devices)) {
        return obj.devices as Array<Record<string, unknown>>;
      }
      if (typeof obj.macAddress === 'string') {
        return [obj];
      }
    }
    return [];
  }
}
