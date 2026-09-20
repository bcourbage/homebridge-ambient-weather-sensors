import { setupBatteryService } from './batteryService.js';
import { batteryOptionsFor } from './sensorMap/batterySeed.js';
/**
 * One row-parameterized implementation for every boolean state kind
 * (§16 genericity: dataPoint, name, and battery ownership all come
 * from the row; nothing is hardcoded to an AWN field).
 */
class BooleanStateAccessory {
    constructor(platform, accessory, spec, row) {
        this.platform = platform;
        this.accessory = accessory;
        this.spec = spec;
        this.row = row;
        this.accessory.getService(this.platform.Service.AccessoryInformation)
            .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Ambient Weather')
            .setCharacteristic(this.platform.Characteristic.Model, spec.model)
            .setCharacteristic(this.platform.Characteristic.SerialNumber, accessory.context.device.uniqueId);
        const ServiceCtor = spec.service(platform);
        this.service = this.accessory.getService(ServiceCtor)
            || this.accessory.addService(ServiceCtor);
        this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.displayName);
        // StatusFault is part of the graph from the start so the fault
        // transition never mutates the service set (§9 signature stability).
        this.service.updateCharacteristic(this.platform.Characteristic.StatusFault, this.platform.Characteristic.StatusFault.NO_FAULT);
        this.batterySetter = setupBatteryService(this.platform, this.accessory, batteryOptionsFor(row, accessory));
        if (typeof accessory.context.device.value === 'number') {
            this.setValue(accessory.context.device.value);
        }
    }
    setBatteryLow(batteryLow) {
        this.batterySetter?.(batteryLow);
    }
    /**
     * The shared explicit decode (§19.1). `coerceValue` passes the finite
     * raw through for boolean rows precisely so this decode sees an
     * out-of-contract value instead of a pre-collapsed truthy 1.
     */
    setValue(rawValue) {
        const characteristic = this.spec.characteristic(this.platform);
        if (rawValue === 0 || rawValue === 1) {
            const state = rawValue === 1
                ? this.spec.activeValue(this.platform)
                : this.spec.clearValue(this.platform);
            this.platform.log.debug(`SET ${this.spec.model} '${this.row.dataPoint}': ${rawValue === 1 ? 'active' : 'clear'}`);
            this.service
                .updateCharacteristic(characteristic, state)
                .updateCharacteristic(this.platform.Characteristic.StatusFault, this.platform.Characteristic.StatusFault.NO_FAULT);
            return;
        }
        // Out of the declared 0/1 vocabulary (the leak family documents
        // 2 = offline): fault, and the alert is FORCED CLEAR.
        this.platform.log.warn(`${this.spec.model} '${this.row.dataPoint}' reported out-of-contract value ${rawValue}; `
            + 'setting StatusFault and keeping the alert clear.');
        this.service
            .updateCharacteristic(characteristic, this.spec.clearValue(this.platform))
            .updateCharacteristic(this.platform.Characteristic.StatusFault, this.platform.Characteristic.StatusFault.GENERAL_FAULT);
    }
}
export class LeakAccessory extends BooleanStateAccessory {
    constructor(platform, accessory, row) {
        super(platform, accessory, {
            model: 'Leak Sensor',
            service: p => p.Service.LeakSensor,
            characteristic: p => p.Characteristic.LeakDetected,
            activeValue: p => p.Characteristic.LeakDetected.LEAK_DETECTED,
            clearValue: p => p.Characteristic.LeakDetected.LEAK_NOT_DETECTED,
        }, row);
    }
}
export class ContactAccessory extends BooleanStateAccessory {
    constructor(platform, accessory, row) {
        super(platform, accessory, {
            model: 'Contact Sensor',
            service: p => p.Service.ContactSensor,
            characteristic: p => p.Characteristic.ContactSensorState,
            // Raw 1 = the sensor is TRIGGERED = the contact is open.
            activeValue: p => p.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
            clearValue: p => p.Characteristic.ContactSensorState.CONTACT_DETECTED,
        }, row);
    }
}
export class OccupancyAccessory extends BooleanStateAccessory {
    constructor(platform, accessory, row) {
        super(platform, accessory, {
            model: 'Occupancy Sensor',
            service: p => p.Service.OccupancySensor,
            characteristic: p => p.Characteristic.OccupancyDetected,
            activeValue: p => p.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED,
            clearValue: p => p.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED,
        }, row);
    }
}
export class SmokeAccessory extends BooleanStateAccessory {
    constructor(platform, accessory, row) {
        super(platform, accessory, {
            model: 'Smoke Sensor',
            service: p => p.Service.SmokeSensor,
            characteristic: p => p.Characteristic.SmokeDetected,
            activeValue: p => p.Characteristic.SmokeDetected.SMOKE_DETECTED,
            clearValue: p => p.Characteristic.SmokeDetected.SMOKE_NOT_DETECTED,
        }, row);
    }
}
/**
 * DIRECT boolean motion (the `motion|boolean` pair) — a state tile
 * driven by a 0/1 field, distinct from the extended threshold shell.
 * Threshold-family fields a motion row may legally carry are inert
 * here: a boolean has no numeric reading to compare.
 */
export class MotionBooleanAccessory extends BooleanStateAccessory {
    constructor(platform, accessory, row) {
        super(platform, accessory, {
            model: 'Motion Sensor',
            service: p => p.Service.MotionSensor,
            characteristic: p => p.Characteristic.MotionDetected,
            activeValue: () => true,
            clearValue: () => false,
        }, row);
    }
}
//# sourceMappingURL=booleanStateAccessory.js.map