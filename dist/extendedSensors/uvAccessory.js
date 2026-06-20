import { ExtendedSensorBase } from './extendedSensorBase.js';
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
    constructor(platform, accessory) {
        const displayMode = platform.config.extendedDisplayMode === 'embed' ? 'embed' : 'static';
        // Blank in HB UI form → undefined → Infinity → never triggers.
        // Accessory still appears so the UV index is visible in Eve.
        const raw = platform.config.thresholds?.uv;
        const threshold = typeof raw === 'number' ? raw : Infinity;
        super(platform, accessory, {
            sensorLabel: 'UV Index',
            awnKey: 'uv',
            threshold,
            displayMode,
        });
    }
    formatValue(rawUv) {
        return `${Math.round(rawUv)}`;
    }
    formatIntensity(rawUv) {
        return uvBucket(rawUv);
    }
}
//# sourceMappingURL=uvAccessory.js.map