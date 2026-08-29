/**
 * Cursor reconciliation — the correctness core of this application.
 *
 * The contract, verified against upstream `src/store.py::read_messages` and `src/interop.md`:
 *
 *   - A read with `since=N` returns the tail above N. `first_seq` is the lowest sequence
 *     the read could actually return.
 *   - `first_seq > N + 1` means the readable window advanced past the cursor: those
 *     sequence positions can no longer be read by anyone. That is a coverage gap.
 *   - An empty tail returns `first_seq: null` and `last_seq: since or 0`, so an empty
 *     read echoes the caller's own cursor back and must not be read as a regression.
 *   - Upstream does not guarantee one message per sequence position, so a gap is measured
 *     in SEQUENCE POSITIONS, never in messages.
 *
 * The cursor means HIGHEST OBSERVED TAIL. It never means highest contiguous delivery.
 */

import type { GapEvent, ObservedRoom } from './types';

export interface RoomReadInput {
  room: string;
  /** `first_seq` from the response. Null when the tail was empty. */
  firstSeq: number | null;
  /** `last_seq` from the response. */
  lastSeq: number;
  /** Sequences actually present in the response body. */
  seqs: number[];
  /** Room lifetime epoch, when the deployment exposes one. */
  generation?: number | null;
  observedAt: number;
}

export interface RoomReadResult {
  room: ObservedRoom;
  /** Coverage events produced by this read, in the order they occurred. */
  events: GapEvent[];
  /** Sequences accepted as new observations, ascending and deduplicated. */
  acceptedSeqs: number[];
  /** Sequences dropped because this session had already observed them. */
  duplicateSeqs: number[];
}

export function createRoomState(room: string): ObservedRoom {
  return {
    room,
    cursor: null,
    firstObservedSeq: null,
    lastObservedSeq: null,
    latestFirstSeq: null,
    latestLastSeq: null,
    messagesObserved: 0,
    knownMissingSequencePositions: 0,
    gapCount: 0,
    lastPollAt: null,
    generation: null,
  };
}

/**
 * Fold one room read into room state.
 *
 * Ordering is deliberate and load-bearing:
 *   1. classify the cold start / epoch reset / gap BEFORE touching the cursor
 *   2. accept the readable tail
 *   3. advance the cursor to `last_seq`
 *
 * Recording after advancing would lose the evidence, because the advanced cursor is
 * indistinguishable from a clean sequential read.
 */
export function applyRoomRead(
  prev: ObservedRoom,
  read: RoomReadInput,
  observedSeqs: ReadonlySet<number>,
): RoomReadResult {
  const events: GapEvent[] = [];
  const priorCursor = prev.cursor;
  const room = read.room;

  // An epoch reset is not a gap: the name now carries a different conversation, so the
  // previous cursor does not describe the same sequence space at all.
  const epochReset =
    (prev.generation !== null &&
      read.generation !== null &&
      read.generation !== undefined &&
      read.generation !== prev.generation) ||
    (priorCursor !== null && read.firstSeq !== null && read.firstSeq <= priorCursor);

  if (priorCursor === null) {
    // Cold start. A missing prior cursor is NOT sequence 0: everything before this point
    // is outside the session's coverage claim, not a detected delivery failure.
    events.push({
      kind: 'observation-start',
      room,
      observedAt: read.observedAt,
      previousCursor: null,
      expectedNextSeq: null,
      firstReadableSeq: read.firstSeq,
      missingSequencePositions: 0,
    });
  } else if (epochReset) {
    events.push({
      kind: 'epoch-reset',
      room,
      observedAt: read.observedAt,
      previousCursor: priorCursor,
      expectedNextSeq: priorCursor + 1,
      firstReadableSeq: read.firstSeq,
      missingSequencePositions: 0,
    });
  } else if (read.firstSeq !== null && read.firstSeq > priorCursor + 1) {
    // The readable window advanced beyond the cursor. Record it before advancing.
    events.push({
      kind: 'gap',
      room,
      observedAt: read.observedAt,
      previousCursor: priorCursor,
      expectedNextSeq: priorCursor + 1,
      firstReadableSeq: read.firstSeq,
      missingSequencePositions: read.firstSeq - priorCursor - 1,
    });
  }

  // Deduplicate against everything this session has already observed for this room.
  const acceptedSeqs: number[] = [];
  const duplicateSeqs: number[] = [];
  const seenInThisRead = new Set<number>();
  for (const seq of [...read.seqs].sort((a, b) => a - b)) {
    if (observedSeqs.has(seq) || seenInThisRead.has(seq)) {
      duplicateSeqs.push(seq);
      continue;
    }
    seenInThisRead.add(seq);
    acceptedSeqs.push(seq);
  }

  const gap = events.find((e) => e.kind === 'gap');
  const next: ObservedRoom = {
    ...prev,
    latestFirstSeq: read.firstSeq ?? prev.latestFirstSeq,
    latestLastSeq: read.lastSeq,
    generation: read.generation ?? prev.generation,
    lastPollAt: read.observedAt,
    messagesObserved: prev.messagesObserved + acceptedSeqs.length,
    gapCount: prev.gapCount + (gap ? 1 : 0),
    knownMissingSequencePositions:
      prev.knownMissingSequencePositions + (gap?.missingSequencePositions ?? 0),
  };

  if (acceptedSeqs.length > 0) {
    const lowest = acceptedSeqs[0];
    const highest = acceptedSeqs[acceptedSeqs.length - 1];
    next.firstObservedSeq =
      prev.firstObservedSeq === null ? lowest : Math.min(prev.firstObservedSeq, lowest);
    next.lastObservedSeq =
      prev.lastObservedSeq === null ? highest : Math.max(prev.lastObservedSeq, highest);
  }

  // The cursor advances to the readable tail even across a recorded gap: the returned
  // activity is real and processable. The gap ledger — not the cursor — carries the fact
  // that coverage is incomplete.
  if (epochReset) {
    next.cursor = read.lastSeq > 0 ? read.lastSeq : priorCursor;
  } else if (priorCursor === null) {
    next.cursor = read.lastSeq > 0 ? read.lastSeq : null;
  } else {
    next.cursor = Math.max(priorCursor, read.lastSeq);
  }

  return { room: next, events, acceptedSeqs, duplicateSeqs };
}

/** True once any real coverage gap has been recorded. Cold start alone never sets this. */
export function hasKnownGap(events: readonly GapEvent[]): boolean {
  return events.some((e) => e.kind === 'gap');
}

/**
 * Sequence positions this session observed, over the span it attempted to cover.
 *
 * The denominator is the session's own attempted span, so this is explicitly a
 * SESSION coverage figure. It is never a statement about Technocore's total history,
 * for which this observer has no authoritative denominator.
 */
export function knownSessionCoverage(rooms: readonly ObservedRoom[]): number | null {
  let observed = 0;
  let span = 0;
  for (const r of rooms) {
    if (r.firstObservedSeq === null || r.lastObservedSeq === null) continue;
    observed += r.messagesObserved;
    span += r.lastObservedSeq - r.firstObservedSeq + 1;
  }
  if (span <= 0) return null;
  return Math.min(1, observed / span);
}
