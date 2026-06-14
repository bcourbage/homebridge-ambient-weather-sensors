import { API, Characteristic, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service } from 'homebridge';
import { DEVICE } from './types.js';
/**
 * Common shape for the per-accessory wrapper instances the platform
 * tracks. Each wrapper exposes a single push-style `setValue` entry
 * point that the platform's poll tick uses to deliver the freshly
 * fetched value, performing whatever unit conversion is appropriate for
 * the underlying HomeKit characteristic.
 */
export interface SensorAccessory {
    setValue(rawValue: number): void;
    /**
     * Optional hook for per-probe battery state. Implementations that
     * advertise a Battery sub-service should override this to flip
     * `StatusLowBattery` based on the boolean. Called by the polling
     * and realtime fanout in addition to `setValue` on each tick.
     *
     * Default no-op for accessories that don't expose a battery — the
     * platform calls this blindly and lets the wrapper decide whether
     * to act.
     */
    setBatteryLow?(batteryLow: boolean): void;
}
export declare class AmbientWeatherSensorsPlatform implements DynamicPlatformPlugin {
    readonly log: Logger;
    readonly config: PlatformConfig;
    readonly api: API;
    readonly Service: typeof Service;
    readonly Characteristic: typeof Characteristic;
    readonly accessories: PlatformAccessory[];
    private readonly wrappers;
    private readonly loggedExcludeHits;
    private readonly loggedIncludeMisses;
    private readonly loggedStationFilterDrops;
    private warnedStationFilterEmpty;
    private pollTimer;
    private realtimeSource;
    constructor(log: Logger, config: PlatformConfig, api: API);
    configureAccessory(accessory: PlatformAccessory): void;
    determineSensorType(sensor: string): "Solar Radiation" | "CO2" | "Temperature" | "Humidity" | "PM2.5" | "PM10" | "NOT_SUPPORTED" | "WindSpeed" | "WindGust" | "WindMaxDailyGust" | "WindDirection" | "WindDirection10m" | "RainRate" | "RainEvent" | "RainDaily" | "RainWeekly" | "RainMonthly" | "RainYearly" | "LastRain" | "PressureRelative" | "PressureAbsolute" | "UV" | "LightningDay" | "LightningHour" | "LightningDistance" | "LightningLastStrike";
    /**
     * Compose a HAP-clean accessory displayName from station + sensor
     * metadata.
     *
     * Single-station setups (the vast majority) get just the sensor
     * label — e.g. "Indoor Temperature" — so the Apple Home tile reads
     * cleanly without a station prefix. Multi-station setups get the
     * prefix to disambiguate — e.g. "Backyard Station Indoor
     * Temperature" — falling back to `${mac_no_colons} ${sensor_label}`
     * if the user hasn't set a station name on ambientweather.net.
     *
     * Why the split: Apple Home's tile only honors a custom Name field
     * after the user explicitly renames via the Home app (the rename
     * action flips an internal "user-confirmed" flag; programmatic
     * `setCharacteristic` from the accessory side doesn't). Until then,
     * the tile shows `accessory.displayName` verbatim. So for the
     * single-station case where the station prefix is redundant, we
     * have to drop it at the displayName level — not at the service
     * Name level — to get clean tiles by default.
     *
     * City/state are intentionally NOT included even though the API
     * supplies them: HomeKit's room/home hierarchy already gives users a
     * place to express location, and dragging the geocoded address into
     * every accessory name produces redundant noise on the device tile.
     *
     * Truncates from the right to HAP 2.x's 64-character `Name` limit.
     */
    composeDisplayName(obj: {
        macAddress: string;
        info?: {
            name?: string;
        };
    }, sensorKey: string, isMultiStation: boolean): string;
    parseDevices(json: any): DEVICE[];
    sleep: (delay: any) => Promise<unknown>;
    fetchDevices(): any;
    /**
     * Unregister any cached accessories whose underlying sensor is no
     * longer present in the API response (or has been excluded via
     * `excludeSensors` / a per-type toggle being turned off). Matching is
     * by `context.device.uniqueId` — the stable `${mac}-${sensorKey}`
     * identifier — rather than by `displayName`. Matching by displayName
     * caused a regression where any change to the naming convention (e.g.
     * the colon-strip in HB2 compat, or the station-name rollout in this
     * branch) made every cached accessory look like an orphan and got
     * them all unregistered from HAP on the first restart after the
     * rename. uniqueId is stable across renames and is what the for-loop
     * downstream uses for UUID generation, so they're the same identity
     * notion.
     */
    deregisterAccessories(Devices: DEVICE[]): void;
    discoverDevices(): any;
    /**
     * Construct the right sensor-type wrapper for an accessory based on
     * the cached context.device.type. Returns the wrapper so the platform
     * can index it by uniqueId for the poll-and-distribute loop.
     */
    private createSensorWrapper;
    /**
     * Start the platform-level poll timer. One timer covers every
     * accessory: on each tick we fetch the full devices payload from AWN
     * once and fan the values out to wrappers via setValue(). Previously
     * every wrapper owned its own setInterval, which meant N accessories
     * triggered N parallel fetches per cycle — racing AWN's 1 req/s
     * rate limit and getting "saved" only by the disk cache.
     */
    private startPolling;
    /**
     * Open a long-lived websocket subscription to AWN's realtime endpoint.
     * Sensor updates arrive as they happen (typically ~30s cadence
     * indoors), feed through the same `distribute` fanout the poll path
     * uses, and end up calling setValue() on the matching wrapper.
     */
    private startRealtime;
    /**
     * Fetch fresh values once and push each one into the matching wrapper.
     * Wrappers not present in the response are simply left untouched on
     * this tick — HomeKit will keep showing the last known value.
     */
    private pollAndDistribute;
    /**
     * Common fanout used by both the polling and realtime data sources.
     * Looks up each update's wrapper by uniqueId; values for sensors we
     * never registered (unknown sensor types, excluded by config, etc.)
     * are silently ignored.
     */
    private distribute;
}
//# sourceMappingURL=platform.d.ts.map