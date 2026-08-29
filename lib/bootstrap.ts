/**
 * Initial application state.
 *
 * The `?demo=1` decision and the session it produces live here rather than inline in the
 * component, so "does demo mode actually install a populated session?" is a question that
 * can be answered without mounting React. That question is the one the previous
 * implementation got wrong in a way its tests could not see.
 */

import { ObservationSessionState } from './session';
import { generateSyntheticSession } from './synthetic';
import type { ObservatoryMode } from './types';

/** Read the demo flag from already-parsed search params. */
export function isDemoRequested(
  params: Record<string, string | string[] | undefined>,
): boolean {
  const value = params.demo;
  const first = Array.isArray(value) ? value[0] : value;
  return first === '1' || first === 'true';
}

export interface InitialState {
  session: ObservationSessionState;
  mode: ObservatoryMode;
}

/**
 * The session the app opens with. Demo mode opens on a fully populated synthetic session,
 * so the first painted frame already has observations in it; live mode opens on an empty
 * live session that the collector then fills.
 *
 * `endsAt` is passed in rather than read from the clock here. The synthetic generator is
 * deterministic in its seed but not in time, so the server render and the client's
 * hydrating render produced sessions ending at two different instants, whose metric text
 * disagreed — and React then threw the server tree away as a hydration mismatch. One
 * timestamp, chosen once on the server and handed to both renders, keeps them identical.
 */
export function createInitialState(demo: boolean, endsAt: number): InitialState {
  return demo
    ? { session: generateSyntheticSession({ endsAt }), mode: 'synthetic' }
    : { session: new ObservationSessionState('live'), mode: 'live' };
}
