import { Characteristic, CharacteristicValue, PlatformAccessory, Service, WithUUID } from 'homebridge';

import { setupBatteryService } from './batteryService.js';
import { AmbientWeatherSensorsPlatform, SensorAccessory } from './platform.js';
import { batteryOptionsFor } from './sensorMap/batterySeed.js';
import type { BooleanSensorRow } from './sensorMap/types.js';

/**
 * Per-kind wiring for the boolean STATE family (sensor-map.md §19.1):
 * which HAP service renders the state, which characteristic carries
 * the alert, and the HAP values for active/clear. The DECODE contract
 * is shared and explicit:
 *
 *   raw 0                         → clear, fault cleared
 *   raw 1                         → active, fault cleared
 *   anything else (>= 2, negative,
 *   non-integer)                  → StatusFault GENERAL_FAULT and the
 *                                   alert FORCED CLEAR
 *
 * A value outside the declared 0/1 vocabulary must never read as an
 * alarm — the canonical case is the leak family's documented
 * `2 = offline`, which previously coerced to "leak detected" through
 * generic boolean truthiness.
 */
interface BooleanStateSpec {
  model: string;
  service: (platform: AmbientWeatherSensorsPlatform) => WithUUID<typeof Service>;
  characteristic: (platform: AmbientWeatherSensorsPlatform) => WithUUID<new () => Characteristic>;
  activeValue: (platform: AmbientWeatherSensorsPlatform) => CharacteristicValue;
  clearValue: (platform: AmbientWeatherSensorsPlatform) => CharacteristicValue;
}

/**
 * One row-parameterized implementation for every boolean state kind
 * (§16 genericity: dataPoint, name, and battery ownership all come
 * from the row; nothing is hardcoded to an AWN field).
 */
abstract class BooleanStateAccessory implements SensorAccessory {
  private readonly service: Service;
  private readonly batterySetter?: (low: boolean) => void;

  constructor(
    private readonly platform: AmbientWeatherSensorsPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly spec: BooleanStateSpec,
    private readonly row: BooleanSensorRow,
  ) {
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Ambient Weather')
      .setCharacteristic(this.platform.Characteristic.Model, spec.model)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, accessory.context.device.uniqueId);

    const ServiceCtor = spec.service(platform);
    this.service = this.accessory.getService(ServiceCtor)
                || this.accessory.addService(ServiceCtor as unknown as Service);
    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.displayName);
    // StatusFault is part of the graph from the start so the fault
    // transition never mutates the service set (§9 signature stability).
    this.service.updateCharacteristic(
      this.platform.Characteristic.StatusFault,
      this.platform.Characteristic.StatusFault.NO_FAULT,
    );

    this.batterySetter = setupBatteryService(
      this.platform, this.accessory, batteryOptionsFor(row, accessory),
    );

    if (typeof accessory.context.device.value === 'number') {
      this.setValue(accessory.context.device.value);
    }
  }

  setBatteryLow(batteryLow: boolean): void {
    this.batterySetter?.(batteryLow);
  }

  /**
   * The shared explicit decode (§19.1). `coerceValue` passes the finite
   * raw through for boolean rows precisely so this decode sees an
   * out-of-contract value instead of a pre-collapsed truthy 1.
   */
  setValue(rawValue: number): void {
    const characteristic = this.spec.characteristic(this.platform);
    if (rawValue === 0 || rawValue === 1) {
      const state = rawValue === 1
        ? this.spec.activeValue(this.platform)
        : this.spec.clearValue(this.platform);
      this.platform.log.debug(
        `SET ${this.spec.model} '${this.row.dataPoint}': ${rawValue === 1 ? 'active' : 'clear'}`);
      this.service
        .updateCharacteristic(characteristic, state)
        .updateCharacteristic(
          this.platform.Characteristic.StatusFault,
          this.platform.Characteristic.StatusFault.NO_FAULT,
        );
      return;
    }
    // Out of the declared 0/1 vocabulary (the leak family documents
    // 2 = offline): fault, and the alert is FORCED CLEAR.
    this.platform.log.warn(
      `${this.spec.model} '${this.row.dataPoint}' reported out-of-contract value ${rawValue}; `
      + 'setting StatusFault and keeping the alert clear.');
    this.service
      .updateCharacteristic(characteristic, this.spec.clearValue(this.platform))
      .updateCharacteristic(
        this.platform.Characteristic.StatusFault,
        this.platform.Characteristic.StatusFault.GENERAL_FAULT,
      );
  }
}

export class LeakAccessory extends BooleanStateAccessory {
  constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory, row: BooleanSensorRow) {
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
  constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory, row: BooleanSensorRow) {
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
  constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory, row: BooleanSensorRow) {
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
  constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory, row: BooleanSensorRow) {
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
  constructor(platform: AmbientWeatherSensorsPlatform, accessory: PlatformAccessory, row: BooleanSensorRow) {
    super(platform, accessory, {
      model: 'Motion Sensor',
      service: p => p.Service.MotionSensor,
      characteristic: p => p.Characteristic.MotionDetected,
      activeValue: () => true,
      clearValue: () => false,
    }, row);
  }
}
