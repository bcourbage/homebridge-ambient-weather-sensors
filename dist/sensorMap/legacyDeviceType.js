/**
 * wrapperId → v1.7 `context.device.type` bridge (finding-#4 Stage 4).
 *
 * The row-driven v2 reconciler instantiates wrappers by `wrapperId` (via
 * `instantiateWrapper`), NOT by the legacy `context.device.type` string
 * that `createSensorWrapper` switches on. But the cached `context.device`
 * MUST keep a v1.7-compatible `type` so that DOWNGRADING the plugin back
 * to a v1.7 code path finds a `type` its `createSensorWrapper`/
 * `determineSensorType` vocabulary recognises and can rebuild — otherwise
 * a known cached accessory would be stranded (unrecognised type →
 * `createSensorWrapper` returns undefined → no wrapper) on downgrade.
 *
 * These strings are exactly the values `determineSensorType` returns and
 * `createSensorWrapper` switches on in `platform.ts`. `Record<WrapperId,
 * string>` forces exhaustiveness — adding a wrapper id without a legacy
 * type mapping fails to compile.
 */
export const LEGACY_TYPE_FOR_WRAPPER_ID = {
    'temperature': 'Temperature',
    'humidity': 'Humidity',
    'solar-radiation': 'Solar Radiation',
    'co2': 'CO2',
    'air-quality-pm25': 'PM2.5',
    'air-quality-pm10': 'PM10',
    'uv': 'UV',
    'wind-speed': 'WindSpeed',
    'wind-gust': 'WindGust',
    'wind-max-daily-gust': 'WindMaxDailyGust',
    'wind-direction': 'WindDirection',
    'wind-direction-10m': 'WindDirection10m',
    'pressure-relative': 'PressureRelative',
    'pressure-absolute': 'PressureAbsolute',
    'rain-rate': 'RainRate',
    'rain-event': 'RainEvent',
    'rain-daily': 'RainDaily',
    'rain-weekly': 'RainWeekly',
    'rain-monthly': 'RainMonthly',
    'rain-yearly': 'RainYearly',
    'last-rain': 'LastRain',
    'lightning-day': 'LightningDay',
    'lightning-hour': 'LightningHour',
    'lightning-distance': 'LightningDistance',
    'lightning-last-strike': 'LightningLastStrike',
};
/** Legacy `context.device.type` for a resolved row's wrapper id. */
export function legacyTypeForWrapperId(wrapperId) {
    return LEGACY_TYPE_FOR_WRAPPER_ID[wrapperId];
}
//# sourceMappingURL=legacyDeviceType.js.map