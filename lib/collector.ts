/**
 * Live collector.
 *
 * Discovers busy public rooms, then long-polls a bounded set of them through this app's
 * own read-only routes. Concurrency stays under the upstream per-IP waiter budget, and
 * every read is a plain GET. The collector has no write path of any kind.
 */

import {
  MAX_CONCURRENT_POLLS,
  MAX_WATCHED_ROOMS,
  isObservableRoomName,
  parseNormalizedRoomView,
  parseNormalizedRoomsView,
  type RoomListingEntry,
} from './protocol';
import type { ObservationSessionState } from './session';

const WAIT_SECONDS = 8;
const READ_LIMIT = 200;
/** Pause between poll rounds. Keeps well inside the published 600 reads/min per IP. */
const ROUND_DELAY_MS = 700;
const BACKOFF_MS = 5_000;
/** Delay before re-attempting discovery. A discovery failure is transient, not terminal. */
const DISCOVERY_RETRY_MS = 4_000;

/** What the observer is currently doing, for a one-line user-visible status. */
export type CollectorStatus = 'idle' | 'discovering' | 'connecting' | 'observing' | 'retrying';

export interface CollectorEvents {
  onUpdate?: () => void;
  onError?: (message: string) => void;
  onRooms?: (rooms: string[]) => void;
  onStatus?: (status: CollectorStatus) => void;
}

export class LiveCollector {
  private readonly session: ObservationSessionState;
  private readonly events: CollectorEvents;
  private controller: AbortController | null = null;
  private running = false;
  private watched: string[] = [];
  private observedAtLeastOnce = false;

  constructor(session: ObservationSessionState, events: CollectorEvents = {}) {
    if (session.provenance !== 'live') {
      throw new Error('the live collector requires a session with live provenance');
    }
    this.session = session;
    this.events = events;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get watchedRooms(): readonly string[] {
    return this.watched;
  }

  /**
   * Begin observing. Resolves once discovery has produced a watch set and the poll loop is
   * running; the loop itself continues until `stop()`.
   *
   * Discovery is retried rather than treated as fatal. The previous behaviour returned
   * after a single failure and left the observer permanently idle with no polling and no
   * path back to a working state, which is indistinguishable in the UI from silence
   * upstream.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.controller = new AbortController();
    const signal = this.controller.signal;

    for (;;) {
      if (!this.running || signal.aborted) {
        this.running = false;
        this.events.onStatus?.('idle');
        return;
      }

      this.events.onStatus?.('discovering');
      let rooms: string[];
      try {
        rooms = await this.discoverRooms(signal);
      } catch (error) {
        if (signal.aborted) {
          this.running = false;
          this.events.onStatus?.('idle');
          return;
        }
        this.events.onError?.(
          error instanceof Error ? `room discovery failed: ${error.message}` : 'room discovery failed',
        );
        this.events.onStatus?.('retrying');
        await sleep(DISCOVERY_RETRY_MS, signal);
        continue;
      }

      // An empty watch set is a real outcome (every listed room idle or empty), but it must
      // not silently look like a running observer: retry instead of polling nothing.
      if (rooms.length === 0) {
        this.events.onError?.('no active public rooms in the current listing');
        this.events.onStatus?.('retrying');
        await sleep(DISCOVERY_RETRY_MS, signal);
        continue;
      }

      this.watched = rooms;
      this.events.onRooms?.(this.watched);
      this.events.onStatus?.('connecting');
      break;
    }

    void this.loop(signal);
  }

  stop(): void {
    this.running = false;
    this.controller?.abort();
    this.controller = null;
    this.events.onStatus?.('idle');
  }

  /**
   * Pick the rooms worth watching: publicly listed, currently active, and busy enough to
   * produce visible activity. The listing is recency-sorted upstream.
   */
  private async discoverRooms(signal: AbortSignal): Promise<string[]> {
    const response = await fetch('/api/tc/rooms?limit=60', { signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`listing route returned ${response.status}`);
    // This document came from our own route, so it is already normalized to `RoomsView`.
    const listing = parseNormalizedRoomsView(await response.json());
    if (!listing) throw new Error('listing did not match the expected shape');

    const candidates: RoomListingEntry[] = listing.rooms
      .filter((r) => isObservableRoomName(r.room) && r.idleSeconds < 300 && r.lastSeq > 5)
      .sort((a, b) => b.bytes - a.bytes);

    return candidates.slice(0, MAX_WATCHED_ROOMS).map((r) => r.room);
  }

  /** Poll rounds until stopped. Each round reads every watched room at bounded concurrency. */
  private async loop(signal: AbortSignal): Promise<void> {
    while (this.running && !signal.aborted) {
      const queue = [...this.watched];
      const workers = Array.from(
        { length: Math.min(MAX_CONCURRENT_POLLS, queue.length) },
        async () => {
          while (this.running && !signal.aborted) {
            const room = queue.shift();
            if (room === undefined) return;
            await this.pollRoom(room, signal);
          }
        },
      );
      await Promise.all(workers);
      if (!this.running || signal.aborted) return;
      this.session.noteSpikeIfAny();
      await sleep(ROUND_DELAY_MS, signal);
    }
  }

  private async pollRoom(room: string, signal: AbortSignal): Promise<void> {
    const state = this.session.rooms.get(room);
    const cursor = state?.cursor ?? null;

    // A cold read omits `since` entirely: a missing cursor is not sequence 0, and asking
    // for `since=0` would misrepresent the session's coverage claim.
    const params = new URLSearchParams({ limit: String(READ_LIMIT), wait: String(WAIT_SECONDS) });
    if (cursor !== null) params.set('since', String(cursor));

    let payload: unknown;
    try {
      const response = await fetch(`/api/tc/room/${encodeURIComponent(room)}?${params}`, {
        signal,
        cache: 'no-store',
      });
      if (response.status === 429) {
        this.events.onError?.('upstream rate limit reached, backing off');
        this.events.onStatus?.('retrying');
        await sleep(BACKOFF_MS, signal);
        return;
      }
      if (!response.ok) {
        this.events.onError?.(`room read failed for ${room} (${response.status})`);
        this.events.onStatus?.('retrying');
        await sleep(BACKOFF_MS, signal);
        return;
      }
      payload = await response.json();
    } catch {
      // An abort is this observer shutting down, not an upstream problem: stay quiet.
      if (signal.aborted) return;
      this.events.onError?.(`room read failed for ${room}`);
      this.events.onStatus?.('retrying');
      await sleep(BACKOFF_MS, signal);
      return;
    }

    // The payload came from our own route, so it is already `RoomView`-shaped. Parsing it
    // with the upstream (`first_seq`) parser reports every read as an empty tail.
    const view = parseNormalizedRoomView(payload, room);
    if (!view) {
      this.events.onError?.(`unreadable room view for ${room}`);
      return;
    }

    this.session.ingestRoomRead({
      room,
      firstSeq: view.firstSeq,
      lastSeq: view.lastSeq,
      seqs: view.messages.map((m) => m.seq),
      generation: view.generation,
      observedAt: Date.now(),
      messages: view.messages,
      provenance: 'live',
    });

    if (!this.observedAtLeastOnce) this.observedAtLeastOnce = true;
    this.events.onStatus?.('observing');
    this.events.onUpdate?.();
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
