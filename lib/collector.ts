/**
 * Live collector.
 *
 * Discovers busy public rooms once, then long-polls a bounded set of them through this
 * app's own read-only routes. Concurrency stays under the upstream per-IP waiter budget,
 * and every read is a plain GET. The collector has no write path of any kind.
 */

import {
  MAX_CONCURRENT_POLLS,
  MAX_WATCHED_ROOMS,
  isObservableRoomName,
  parseRoomView,
  parseRoomsView,
  type RoomListingEntry,
} from './protocol';
import type { ObservationSessionState } from './session';

const WAIT_SECONDS = 8;
const READ_LIMIT = 200;
/** Pause between poll rounds. Keeps well inside the published 600 reads/min per IP. */
const ROUND_DELAY_MS = 700;
const BACKOFF_MS = 5_000;

export interface CollectorEvents {
  onUpdate?: () => void;
  onError?: (message: string) => void;
  onRooms?: (rooms: string[]) => void;
}

export class LiveCollector {
  private readonly session: ObservationSessionState;
  private readonly events: CollectorEvents;
  private controller: AbortController | null = null;
  private running = false;
  private watched: string[] = [];

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

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.controller = new AbortController();
    const signal = this.controller.signal;

    try {
      this.watched = await this.discoverRooms(signal);
      this.events.onRooms?.(this.watched);
    } catch {
      this.running = false;
      this.events.onError?.('room discovery failed');
      return;
    }

    void this.loop(signal);
  }

  stop(): void {
    this.running = false;
    this.controller?.abort();
    this.controller = null;
  }

  /**
   * Pick the rooms worth watching: publicly listed, currently active, and busy enough to
   * produce visible activity. The listing is recency-sorted upstream.
   */
  private async discoverRooms(signal: AbortSignal): Promise<string[]> {
    const response = await fetch('/api/tc/rooms?limit=60', { signal, cache: 'no-store' });
    if (!response.ok) throw new Error('discovery failed');
    const listing = parseRoomsView(await response.json());
    if (!listing) throw new Error('discovery returned an unexpected shape');

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
        await sleep(BACKOFF_MS, signal);
        return;
      }
      if (!response.ok) {
        await sleep(BACKOFF_MS, signal);
        return;
      }
      payload = await response.json();
    } catch {
      if (!signal.aborted) await sleep(BACKOFF_MS, signal);
      return;
    }

    const view = parseRoomView(payload, room);
    if (!view) return;

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
