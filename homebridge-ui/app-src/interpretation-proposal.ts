import { sourceSelectionValid } from './capability-contract';
import { DraftStore, type DraftableField } from './draft-store';
import type { EditorAuthoredFragmentDto, EditorRowDto, VocabularyDto } from './dto/editor-state';

/** Local form intent only. Effective values and consequences are resolved by the server. */
export interface InterpretationChoice {
  pair: string;
  sourceUnit: string;
  displayUnit: string;
  unitLabel: string;
  threshold: number | null;
  triggerDirection: 'above' | 'below';
}

export function customInterpretation(row: EditorRowDto): boolean {
  return row.kind !== 'unrecognized' && (row.identityScope === 'custom-global' || row.identityScope === 'custom-station')
    && (row.origin === 'global' || row.origin === 'station');
}

/**
 * Construct an isolated proposal at the existing row edit key. This is a
 * field-presence operation, not a resolver: untouched fragments retain their
 * order and authorship, and cross-scope effects are left to /preview-save.
 */
export function interpretationProposal(
  authored: EditorAuthoredFragmentDto[], row: EditorRowDto, choice: InterpretationChoice,
  vocab: VocabularyDto, adopted: number,
): Record<string, unknown>[] | undefined {
  const pair = vocab.assignments.find(a => a.id === choice.pair);
  const store = new DraftStore();
  store.reset(authored);
  if (!customInterpretation(row) || !store.faithfullyReconstructable || !pair || pair.since > adopted
    || !sourceSelectionValid(pair, choice.sourceUnit, vocab)
    || typeof choice.unitLabel !== 'string'
    || (choice.threshold !== null && (typeof choice.threshold !== 'number' || !Number.isFinite(choice.threshold)))
    || !['above', 'below'].includes(choice.triggerDirection)) { return undefined; }
  const displays = vocab.measurements[pair.measurement].extendedDisplay;
  if (displays.length && !displays.some(u => u.unit === choice.displayUnit)) { return undefined; }

  const scope = row.origin === 'global' ? undefined : row.stationMac;
  const replaced: DraftableField[] = [
    'kind', 'measurement', 'sourceUnit', 'displayUnit', 'unitLabel',
    'threshold', 'triggerEnabled', 'triggerDirection',
  ];
  for (const field of replaced) store.removeFieldAt(scope, row.dataPoint, field);
  if (pair.kind !== 'motion') store.removeFieldAt(scope, row.dataPoint, 'embedName');
  store.setField(row, 'kind', pair.kind);
  store.setField(row, 'measurement', pair.measurement);
  if (pair.source.type === 'selectable') store.setField(row, 'sourceUnit', choice.sourceUnit);
  else if (pair.source.type === 'fixed-authored') store.setField(row, 'sourceUnit', pair.source.unit);
  // Boolean has no source unit; timestamp's implicit source is milliseconds.
  if (displays.length) store.setField(row, 'displayUnit', choice.displayUnit);
  if (pair.measurement === 'numeric') store.setField(row, 'unitLabel', choice.unitLabel);
  if (pair.triggering) {
    // A station-level deletion could reveal an OLD global threshold in NEW
    // units. Explicitly disable it unless the user supplied a new number.
    store.setField(row, 'triggerEnabled', choice.threshold !== null);
    if (choice.threshold !== null) {
      store.setField(row, 'threshold', choice.threshold);
      store.setField(row, 'triggerDirection', choice.triggerDirection);
    }
  }
  return store.proposal();
}
