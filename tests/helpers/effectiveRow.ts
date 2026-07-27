import type {
  BooleanSensorRow,
  NumericSensorRow,
  TimestampSensorRow,
  WrapperId,
} from '../../src/sensorMap/types';

/**
 * Row builders for the finding-#4 wrapper-parameterization family tests.
 * Stage 2's `test_custom_<family>` tests construct rows EXPLICITLY (the
 * resolution table is still empty until Stage 4, so buildEffectiveSensorMap
 * can't produce a custom row yet). These helpers keep those rows terse
 * and self-consistent while letting each test override the knobs it
 * exercises (name, threshold, sourceUnit, displayUnit, triggerDirection,
 * triggerEnabled, embedName, hasBatterySubService).
 */

const MAC = 'AA:BB:CC:DD:EE:FF';

export function makeNumericRow(partial: Partial<NumericSensorRow> & Pick<NumericSensorRow,
  'kind' | 'measurement' | 'sourceUnit' | 'displayUnit'>): NumericSensorRow {
  const dataPoint = partial.dataPoint ?? 'custom_dp';
  const wrapperId: WrapperId = partial.wrapperId ?? 'temperature';
  return {
    dataPoint,
    stationMac: partial.stationMac ?? MAC,
    name: partial.name ?? 'Custom Sensor',
    kind: partial.kind,
    measurement: partial.measurement,
    sourceUnit: partial.sourceUnit,
    displayUnit: partial.displayUnit,
    threshold: partial.threshold,
    triggerEnabled: partial.triggerEnabled ?? true,
    triggerDirection: partial.triggerDirection ?? 'above',
    batteryField: partial.batteryField ?? null,
    hasBatterySubService: partial.hasBatterySubService ?? false,
    embedName: partial.embedName ?? false,
    enabled: partial.enabled ?? true,
    structuralSignature: partial.structuralSignature ?? `sig-${dataPoint}`,
    wrapperId,
  };
}

export function makeTimestampRow(partial: Partial<TimestampSensorRow> & Pick<TimestampSensorRow,
  'kind'>): TimestampSensorRow {
  const dataPoint = partial.dataPoint ?? 'custom_ts';
  const wrapperId: WrapperId = partial.wrapperId ?? 'last-rain';
  return {
    dataPoint,
    stationMac: partial.stationMac ?? MAC,
    name: partial.name ?? 'Custom Timestamp',
    kind: partial.kind,
    measurement: 'timestamp',
    sourceUnit: 'ms',
    threshold: partial.threshold,
    triggerEnabled: partial.triggerEnabled ?? true,
    triggerDirection: partial.triggerDirection ?? 'above',
    batteryField: partial.batteryField ?? null,
    hasBatterySubService: partial.hasBatterySubService ?? false,
    embedName: partial.embedName ?? false,
    enabled: partial.enabled ?? true,
    structuralSignature: partial.structuralSignature ?? `sig-${dataPoint}`,
    wrapperId,
  };
}

export function makeBooleanRow(partial: Partial<BooleanSensorRow> & Pick<BooleanSensorRow,
  'kind'>): BooleanSensorRow {
  const dataPoint = partial.dataPoint ?? 'custom_bool';
  const wrapperId: WrapperId = partial.wrapperId ?? 'temperature';
  return {
    dataPoint,
    stationMac: partial.stationMac ?? MAC,
    name: partial.name ?? 'Custom Boolean',
    kind: partial.kind,
    measurement: 'boolean',
    triggerEnabled: partial.triggerEnabled ?? true,
    triggerDirection: partial.triggerDirection ?? 'above',
    batteryField: partial.batteryField ?? null,
    hasBatterySubService: partial.hasBatterySubService ?? false,
    embedName: partial.embedName ?? false,
    enabled: partial.enabled ?? true,
    structuralSignature: partial.structuralSignature ?? `sig-${dataPoint}`,
    wrapperId,
  };
}
