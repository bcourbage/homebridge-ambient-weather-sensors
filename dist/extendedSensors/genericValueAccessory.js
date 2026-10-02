import { toDisplayUnit } from '../sensorMap/unitConversions.js';
import { ExtendedSensorBase, extendedDisplayModeFor, thresholdFor, } from './extendedSensorBase.js';
/**
 * The generic extended value accessory (sensor-map.md §19.4): one
 * row-parameterized threshold-shell implementation for the catalog-3
 * numeric measurements (soil-moisture, leaf-wetness, soil-tension,
 * evapotranspiration, aqi). Everything comes from the row — dataPoint,
 * name, units, threshold, trigger direction (§16 genericity). These
 * measurements have no legacy (row-less) path: the wrappers are
 * reachable only through catalog-3 definitions or explicit custom
 * assignments, so the row is required.
 */
const DISPLAY_FORMAT = {
    percent: { decimals: 0, suffix: '%' },
    cb: { decimals: 0, suffix: ' cb' },
    in_per_day: { decimals: 2, suffix: ' in/day' },
    mm_per_day: { decimals: 1, suffix: ' mm/day' },
    index: { decimals: 0, suffix: '' },
};
export class GenericValueAccessory extends ExtendedSensorBase {
    constructor(platform, accessory, row, fallbackLabel) {
        super(platform, accessory, {
            variant: 'numeric',
            sensorLabel: row.name ?? fallbackLabel,
            awnKey: row.dataPoint,
            threshold: thresholdFor(row, Infinity),
            triggerDirection: row.triggerDirection ?? 'above',
            displayMode: extendedDisplayModeFor(platform, row),
            measurement: row.measurement,
            sourceUnit: row.sourceUnit,
        }, row);
        this.displayUnit = row.displayUnit;
        this.rowMeasurement = row.measurement;
        this.unitLabel = row.unitLabel;
    }
    formatValue(canonical) {
        const display = toDisplayUnit(this.rowMeasurement, canonical, this.displayUnit);
        // Generic numeric (§19.9): no invented precision. Render the finite
        // value's ordinary string form (which drops trailing zeros and uses
        // scientific notation for extremes) and append the literal label,
        // if any. `raw` never converts, so `display === canonical`.
        if (this.rowMeasurement === 'numeric') {
            const suffix = this.unitLabel && this.unitLabel.length > 0 ? ` ${this.unitLabel}` : '';
            return `${String(display)}${suffix}`;
        }
        const format = DISPLAY_FORMAT[this.displayUnit] ?? { decimals: 0, suffix: ` ${this.displayUnit}` };
        return `${display.toFixed(format.decimals)}${format.suffix}`;
    }
}
export class SoilMoistureAccessory extends GenericValueAccessory {
    constructor(platform, accessory, row) {
        super(platform, accessory, row, 'Soil Moisture');
    }
}
export class LeafWetnessAccessory extends GenericValueAccessory {
    constructor(platform, accessory, row) {
        super(platform, accessory, row, 'Leaf Wetness');
    }
}
export class SoilTensionAccessory extends GenericValueAccessory {
    constructor(platform, accessory, row) {
        super(platform, accessory, row, 'Soil Tension');
    }
}
export class EvapotranspirationAccessory extends GenericValueAccessory {
    constructor(platform, accessory, row) {
        super(platform, accessory, row, 'Evapotranspiration');
    }
}
export class AqiAccessory extends GenericValueAccessory {
    constructor(platform, accessory, row) {
        super(platform, accessory, row, 'Air Quality Index');
    }
}
/**
 * Generic numeric passthrough (§19.9, catalog 4). An honest finite
 * reading with a user-supplied literal label and an optional threshold.
 * No `formatIntensity` override, so no Intensity characteristic and no
 * invented qualitative classification.
 */
export class NumericAccessory extends GenericValueAccessory {
    constructor(platform, accessory, row) {
        super(platform, accessory, row, 'Numeric Value');
    }
}
//# sourceMappingURL=genericValueAccessory.js.map