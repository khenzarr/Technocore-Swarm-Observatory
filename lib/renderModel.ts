/**
 * The field's render model.
 *
 * This is the handoff boundary between an observation session and the canvas: given a
 * session and a time window, it answers "what is visible, and where". Keeping it here
 * rather than inline in the draw loop means the question "did any observation actually
 * reach the visualization?" can be asked in a test without a pixel.
 *
 * The mark set is returned in parallel typed arrays and the buffer is reusable, because
 * the draw loop asks this question every frame over tens of thousands of observations and
 * must not allocate per mark.
 */

import type { GapEvent } from './types';
import type { ObservationSessionState } from './session';

export interface FieldWindow {
  /** Right edge of the visible window. */
  now: number;
  /** Width of the visible window, in ms. */
  windowMs: number;
  /** `null` shows every room. */
  roomFilter?: string | null;
}

/** Visible observation marks, as parallel arrays valid for indices `0..count-1`. */
export interface MarkBuffer {
  count: number;
  capacity: number;
  observedAt: Float64Array;
  lane: Int32Array;
  room: string[];
}

/** Visible sender trail: the segment of a sender's thread inside the window. */
export interface TrailSegment {
  lane: number;
  from: number;
  to: number;
  room: string;
  /** True when the sender's first observation itself falls inside the window. */
  entersHere: boolean;
}

export function createMarkBuffer(capacity = 4096): MarkBuffer {
  return {
    count: 0,
    capacity,
    observedAt: new Float64Array(capacity),
    lane: new Int32Array(capacity),
    room: new Array<string>(capacity),
  };
}

/**
 * Lane count for the field. Lanes are assigned in observation order and never reused, so
 * the highest assigned lane — not the sender count — defines the geometry.
 */
export function laneCount(session: ObservationSessionState): number {
  let highest = 0;
  for (const sender of session.senders.values()) {
    if (sender.lane + 1 > highest) highest = sender.lane + 1;
  }
  return Math.max(highest, 1);
}

/** Inclusive window bounds for a right edge and span. */
export function windowBounds({ now, windowMs }: FieldWindow): { t0: number; t1: number } {
  return { t0: now - windowMs, t1: now };
}

/**
 * Collect the observation marks inside the window, optionally filtered to one room.
 *
 * An observation with no indexed sender is skipped: a mark has no lane to sit on, so it
 * has no position in the field.
 */
export function collectVisibleMarks(
  session: ObservationSessionState,
  window: FieldWindow,
  into: MarkBuffer = createMarkBuffer(),
): MarkBuffer {
  const { t0, t1 } = windowBounds(window);
  const filter = window.roomFilter ?? null;
  const messages = session.messages;

  let count = 0;
  let buffer = into;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.observedAt < t0 || m.observedAt > t1) continue;
    if (filter !== null && m.room !== filter) continue;
    const sender = session.senders.get(m.sender);
    if (!sender) continue;
    if (count === buffer.capacity) buffer = grow(buffer);
    buffer.observedAt[count] = m.observedAt;
    buffer.lane[count] = sender.lane;
    buffer.room[count] = m.room;
    count++;
  }
  buffer.count = count;
  return buffer;
}

/** Sender trails clipped to the window, in lane-assignment order. */
export function collectVisibleTrails(
  session: ObservationSessionState,
  window: FieldWindow,
): TrailSegment[] {
  const { t0, t1 } = windowBounds(window);
  const filter = window.roomFilter ?? null;
  const trails: TrailSegment[] = [];
  for (const sender of session.senders.values()) {
    if (filter !== null && !sender.roomsObserved.includes(filter)) continue;
    if (sender.lastObservedAt < t0 || sender.firstObservedAt > t1) continue;
    trails.push({
      lane: sender.lane,
      from: Math.max(sender.firstObservedAt, t0),
      to: Math.min(sender.lastObservedAt, t1),
      room: sender.latestRoom,
      entersHere: sender.firstObservedAt >= t0,
    });
  }
  return trails;
}

/** Coverage events inside the window: gap bands, cold starts and epoch resets. */
export function collectVisibleCoverageEvents(
  session: ObservationSessionState,
  window: FieldWindow,
): GapEvent[] {
  const { t0, t1 } = windowBounds(window);
  const filter = window.roomFilter ?? null;
  return session.coverageEvents.filter(
    (event) =>
      event.observedAt >= t0 &&
      event.observedAt <= t1 &&
      (filter === null || event.room === filter),
  );
}

function grow(buffer: MarkBuffer): MarkBuffer {
  const capacity = buffer.capacity * 2;
  const observedAt = new Float64Array(capacity);
  const lane = new Int32Array(capacity);
  observedAt.set(buffer.observedAt);
  lane.set(buffer.lane);
  buffer.room.length = capacity;
  return { count: buffer.count, capacity, observedAt, lane, room: buffer.room };
}
