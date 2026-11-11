/**
 * undone.ts - Calendar date markers for unfinished scheduled tasks.
 *
 * Only live, dated, unfinished tasks contribute. Habits have their own independent
 * check-in UI and must never affect calendar markers.
 */
import type { LocalState } from '../types/types.ts';
import { isGone } from './visibility.ts';

/** Date -> number of unfinished scheduled tasks. */
export function undoneLoads(s: LocalState): Map<string, number> {
  const loads = new Map<string, number>();

  for (const t of Object.values(s.tasks)) {
    if (isGone(t) || t.done || !t.date) continue;
    loads.set(t.date, (loads.get(t.date) || 0) + 1);
  }

  return loads;
}

/** Lookup for date density indicators. */
export const undoneLoadOf = (s: LocalState): ((iso: string) => number) => {
  const loads = undoneLoads(s);
  return (iso) => loads.get(iso) || 0;
};

/** Dates containing at least one unfinished task. */
export function undoneDates(s: LocalState): Set<string> {
  return new Set(undoneLoads(s).keys());
}

/** Single-date query. */
export const hasUndone = (s: LocalState, iso: string): boolean =>
  undoneLoads(s).get(iso) !== undefined;
