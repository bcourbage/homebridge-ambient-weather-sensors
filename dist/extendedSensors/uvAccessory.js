import { ExtendedSensorBase, extendedDisplayModeFor, thresholdFor, } from './extendedSensorBase.js';
import { uvBucket } from './intensityBuckets.js';
/**
 * UV index accessory. AWN's `uv` field is the integer UV index
 * (0-11+), standard EPA scale. Threshold default of 3 corresponds
 * to the "Moderate" bucket — the level where the EPA recommends sun
 * protection — and is a sensible "should I close the window
 * shades" automation trigger.
 *
 * The UV index is unitless, so no per-unit selection is offered;
 * we display the raw integer plus the EPA bucket label.
 */
export class UvAccessory extends ExtendedSensorBase {
    constructor(platform, accessory, row) {
        // Blank in HB UI form → undefined → Infinity → never triggers.
        // Accessory still appears so the UV index is visible in Eve.
        // (Legacy path only — a row supplies its own threshold.)
        const raw = platform.config.thresholds?.uv;
        const threshold = typeof raw === 'number' ? raw : Infinity;
        super(platform, accessory, {
            variant: 'numeric',
            sensorLabel: 'UV Index',
            awnKey: row?.dataPoint ?? 'uv',
            threshold: thresholdFor(row, threshold),
            displayMode: extendedDisplayModeFor(platform, row),
            measurement: 'uv-index',
            sourceUnit: row?.sourceUnit ?? 'index',
        }, row);
    }
    formatValue(canonicalUv) {
        return `${Math.round(canonicalUv)}`;
    }
    formatIntensity(canonicalUv) {
        return uvBucket(canonicalUv);
    }
}
//# sourceMappingURL=uvAccessory.js.map