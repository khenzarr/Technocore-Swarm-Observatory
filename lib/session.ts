/**
 * Session state: the accumulated record of what this observer saw.
 *
 * Mutable by design and deliberately not React state. Observations arrive faster than a
 * component tree should re-render, so the canvas reads this directly on its own frame
 * loop and the metrics strip samples it a few times a second.
 */

import {
  hasDidPrefix,
  parseServerTimestamp,
  senderLabel,
  UPSTREAM_MAIN_SHA,
  type RawMessage,
} from './protocol';
import { applyRoomRead, createRoomState, knownSessionCoverage, type RoomReadInput } from './observer';
import type {
  GapEvent,
  ObservationSession,
  ObservedMessage,
  ObservedRoom,
  ObservedSender,
  Provenance,
  SessionAggregates,
  SessionAnnotation,
} from './types';

const BUCKET_MS = 5_000;
const MAX_BUCKETS = 720; // one hour at 5s
const MAX_MESSAGES = 60_000;
const MAX_ANNOTATIONS = 60;
const SENDER_MILESTONES = [10, 50, 100, 250, 500, 1000];
const EXCERPT_LENGTH = 120;

export class ObservationSessionState {
  readonly provenance: Provenance;
  readonly startedAt: number;
  endedAt: number | null = null;

  readonly rooms = new Map<string, ObservedRoom>();
  readonly senders = new Map<string, ObservedSender>();
  readonly coverageEvents: GapEvent[] = [];
  readonly annotations: SessionAnnotation[] = [];
  /** Ring buffer of observations; the canvas reads this array directly. */
  messages: ObservedMessage[] = [];

  /** Per-room set of sequences already observed, for deduplication. */
  private readonly seenSeqs = new Map<string, Set<number>>();
  private readonly buckets = new Map<number, number>();
  private nextLane = 0;
  private milestoneIndex = 0;
  private sawFirstGap = false;
  private revision = 0;

  constructor(provenance: Provenance, startedAt = Date.now()) {
    this.provenance = provenance;
    this.startedAt = startedAt;
  }

  /** Bumped on every mutation so consumers can cheaply detect staleness. */
  get version(): number {
    return this.revision;
  }

  private seqSet(room: string): Set<number> {
    let set = this.seenSeqs.get(room);
    if (!set) {
      set = new Set<number>();
      this.seenSeqs.set(room, set);
    }
    return set;
  }

  private annotate(kind: SessionAnnotation['kind'], at: number, label: string): void {
    if (this.annotations.length >= MAX_ANNOTATIONS) return;
    this.annotations.push({ kind, at, label });
  }

  /**
   * Fold one validated room read into the session.
   *
   * `provenance` is checked against the session's own: a synthetic read can never land in
   * a live session, and a live read can never land in a synthetic one.
   */
  ingestRoomRead(
    read: RoomReadInput & { messages: RawMessage[]; provenance: Provenance },
  ): GapEvent[] {
    if (read.provenance !== this.provenance) {
      throw new Error(
        `refusing to mix ${read.provenance} data into a ${this.provenance} session`,
      );
    }

    const prev = this.rooms.get(read.room) ?? createRoomState(read.room);
    const isNewRoom = !this.rooms.has(read.room);
    const seen = this.seqSet(read.room);
    const result = applyRoomRead(prev, read, seen);
    this.rooms.set(read.room, result.room);

    const accepted = new Set(result.acceptedSeqs);
    for (const raw of read.messages) {
      if (!accepted.has(raw.seq)) continue;
      seen.add(raw.seq);
      this.recordMessage(raw, read.room, read.observedAt);
    }

    for (const event of result.events) {
      this.coverageEvents.push(event);
      if (event.kind === 'observation-start') {
        this.annotate('observation-started', event.observedAt, `OBSERVATION STARTED · ${event.room}`);
      } else if (event.kind === 'gap' && !this.sawFirstGap) {
        this.sawFirstGap = true;
        this.annotate('first-known-gap', event.observedAt, `FIRST KNOWN GAP · ${event.room}`);
      }
    }

    if (isNewRoom && this.rooms.size > 1) {
      this.annotate('new-room-active', read.observedAt, `NEW ROOM ACTIVE · ${read.room}`);
    }

    this.revision++;
    return result.events;
  }

  private recordMessage(raw: RawMessage, room: string, observedAt: number): void {
    const didPresent = hasDidPrefix(raw.from);
    let sender = this.senders.get(raw.from);
    if (!sender) {
      sender = {
        id: raw.from,
        label: senderLabel(raw.from),
        didPresent,
        firstObservedAt: observedAt,
        lastObservedAt: observedAt,
        messageCount: 0,
        roomsObserved: [],
        latestRoom: room,
        lane: this.nextLane++,
      };
      this.senders.set(raw.from, sender);

      const milestone = SENDER_MILESTONES[this.milestoneIndex];
      if (milestone !== undefined && this.senders.size >= milestone) {
        this.milestoneIndex++;
        this.annotate('senders-milestone', observedAt, `${milestone} SENDERS OBSERVED`);
      }
    }
    sender.lastObservedAt = observedAt;
    sender.messageCount++;
    sender.latestRoom = room;
    if (!sender.roomsObserved.includes(room)) sender.roomsObserved.push(room);

    this.messages.push({
      room,
      seq: raw.seq,
      serverTimestamp: parseServerTimestamp(raw.ts),
      observedAt,
      sender: raw.from,
      textLength: raw.text.length,
      didPresent,
      // Retained as inert display data only. Never parsed, never followed, never executed.
      excerpt: raw.text.slice(0, EXCERPT_LENGTH),
    });
    if (this.messages.length > MAX_MESSAGES) {
      this.messages = this.messages.slice(this.messages.length - MAX_MESSAGES);
    }

    const bucket = Math.floor(observedAt / BUCKET_MS) * BUCKET_MS;
    this.buckets.set(bucket, (this.buckets.get(bucket) ?? 0) + 1);
    if (this.buckets.size > MAX_BUCKETS) {
      const oldest = Math.min(...this.buckets.keys());
      this.buckets.delete(oldest);
    }
  }

  /** Messages-per-minute series, oldest first, as `[bucketStart, ratePerMinute]`. */
  activitySeries(): Array<[number, number]> {
    const keys = [...this.buckets.keys()].sort((a, b) => a - b);
    const perMinute = 60_000 / BUCKET_MS;
    return keys.map((k) => [k, (this.buckets.get(k) ?? 0) * perMinute]);
  }

  /** Rate over the trailing window, so a quiet minute reads as a quiet minute. */
  messagesPerMinute(now = Date.now()): number {
    const since = now - 60_000;
    let count = 0;
    for (const [start, n] of this.buckets) {
      if (start >= since) count += n;
    }
    return count;
  }

  aggregates(now = Date.now()): SessionAggregates {
    const rooms = [...this.rooms.values()];
    return {
      senders: this.senders.size,
      observations: this.messages.length,
      rooms: rooms.filter((r) => r.messagesObserved > 0).length,
      knownGaps: this.coverageEvents.filter((e) => e.kind === 'gap').length,
      knownMissingSequencePositions: rooms.reduce(
        (sum, r) => sum + r.knownMissingSequencePositions,
        0,
      ),
      messagesPerMinute: this.messagesPerMinute(now),
      knownSessionCoverage: knownSessionCoverage(rooms),
    };
  }

  /** Detect a rate spike against the trailing baseline. Annotated at most a few times. */
  noteSpikeIfAny(now = Date.now()): void {
    const series = this.activitySeries();
    if (series.length < 6) return;
    const recent = series[series.length - 1][1];
    const baseline =
      series.slice(-6, -1).reduce((sum, [, v]) => sum + v, 0) / 5;
    if (baseline <= 0 || recent < baseline * 2.5 || recent < 60) return;
    const last = this.annotations[this.annotations.length - 1];
    if (last?.kind === 'activity-spike' && now - last.at < 60_000) return;
    this.annotate('activity-spike', now, `ACTIVITY SPIKE · ${Math.round(recent)}/min`);
  }

  toJSON(now = Date.now()): ObservationSession {
    return {
      schemaVersion: 1,
      provenance: this.provenance,
      startedAt: this.startedAt,
      endedAt: this.endedAt ?? now,
      upstreamMainSha: UPSTREAM_MAIN_SHA,
      rooms: [...this.rooms.values()],
      messages: this.messages,
      senders: [...this.senders.values()],
      coverageEvents: this.coverageEvents,
      annotations: this.annotations,
      aggregates: this.aggregates(now),
    };
  }

  /** Rebuild a session from validated imported data, without re-deriving observations. */
  static fromJSON(session: ObservationSession): ObservationSessionState {
    const state = new ObservationSessionState(session.provenance, session.startedAt);
    state.endedAt = session.endedAt;
    for (const room of session.rooms) state.rooms.set(room.room, room);
    for (const sender of session.senders) state.senders.set(sender.id, sender);
    state.nextLane = session.senders.length;
    state.messages = [...session.messages];
    state.coverageEvents.push(...session.coverageEvents);
    state.annotations.push(...session.annotations);
    for (const m of session.messages) {
      state.seqSet(m.room).add(m.seq);
      const bucket = Math.floor(m.observedAt / BUCKET_MS) * BUCKET_MS;
      state.buckets.set(bucket, (state.buckets.get(bucket) ?? 0) + 1);
    }
    return state;
  }
}
