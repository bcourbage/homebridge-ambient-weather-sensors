import type { CapabilityOptionDto, VocabularyDto } from './dto/editor-state';

const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Validate the negotiated wire shape, not sensor semantics. A cached old bundle uses protocol 1. */
export function isCapabilityVocabulary(value: unknown): value is VocabularyDto {
  if (!record(value) || value.vocabularyProtocol !== 2
    || !record(value.measurements) || !Array.isArray(value.families) || !Array.isArray(value.assignments)) {
    return false;
  }
  const options = (v: unknown): boolean => Array.isArray(v)
    && v.every(u => record(u) && typeof u.unit === 'string' && u.unit.length > 0 && typeof u.label === 'string');
  if (!Object.values(value.measurements).every(m => record(m) && options(m.customSource) && options(m.extendedDisplay))
    || !value.families.every(f => record(f) && typeof f.key === 'string' && typeof f.label === 'string'
      && Array.isArray(f.measurements) && f.measurements.every(m => typeof m === 'string' && Object.hasOwn(value.measurements as object, m))
      && Array.isArray(f.choices) && f.choices.every(c => record(c) && typeof c.id === 'string'
        && typeof c.label === 'string' && record(c.units) && Object.values(c.units).every(u => typeof u === 'string')))) {
    return false;
  }
  const ids = new Set<string>();
  for (const a of value.assignments) {
    if (!record(a) || typeof a.kind !== 'string' || typeof a.measurement !== 'string'
      || a.id !== `${a.kind}|${a.measurement}` || ids.has(a.id as string)
      || typeof a.label !== 'string' || !a.label || !Number.isInteger(a.since) || (a.since as number) < 1
      || typeof a.triggering !== 'boolean' || !record(a.source)
      || !['native-measurement', 'native-state', 'extended-numeric'].includes(a.output as string)
      || typeof a.inputHelp !== 'string' || !a.inputHelp || typeof a.outputHelp !== 'string' || !a.outputHelp
      || !Object.hasOwn(value.measurements, a.measurement) || !record(value.measurements[a.measurement])) {
      return false;
    }
    const units = value.measurements[a.measurement];
    if (!record(units) || !Array.isArray(units.customSource) || !Array.isArray(units.extendedDisplay)) {
      return false;
    }
    switch (a.source.type) {
      case 'selectable':
        if (!units.customSource.length || !units.customSource.every(u => record(u) && typeof u.unit === 'string' && typeof u.label === 'string')) {
          return false;
        }
        break;
      case 'fixed-authored': if (a.source.unit !== 'raw' || a.measurement !== 'numeric') { return false; } break;
      case 'fixed-implicit': if (a.source.unit !== 'ms' || a.measurement !== 'timestamp') { return false; } break;
      case 'none': if (a.measurement !== 'boolean') { return false; } break;
      default: return false;
    }
    if (a.output === 'native-state' && (!record(a.state) || typeof a.state.normal !== 'string' || typeof a.state.active !== 'string')) {
      return false;
    }
    ids.add(a.id as string);
  }
  return ids.size > 0;
}

export function sourceSelectionValid(pair: CapabilityOptionDto, source: unknown, vocab: VocabularyDto): boolean {
  return pair.source.type !== 'selectable'
    || vocab.measurements[pair.measurement].customSource.some(u => u.unit === source);
}
