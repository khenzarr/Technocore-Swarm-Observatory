/**
 * Import validation for session files.
 *
 * An imported file is untrusted input, exactly like an upstream response. Every field is
 * type-checked and range-checked, unknown fields are dropped, and every string is length-
 * bounded. Strings are never interpreted: they reach the DOM only as text children, so a
 * file containing `<script>` markup ends up as visible characters, not as markup.
 */

import type {
  CoverageEventKind,
  GapEvent,
  ObservationSession,
  ObservedMessage,
  ObservedRoom,
  ObservedSender,
  SessionAnnotation,
} from './types';
import { isValidRoomName } from './protocol';

const MAX_MESSAGES = 200_000;
const MAX_SENDERS = 50_000;
const MAX_STRING = 256;

export class SessionImportError extends Error {}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown, fallback: number | null = null): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function int(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : fallback;
}

function str(v: unknown, max = MAX_STRING): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

const COVERAGE_KINDS: readonly CoverageEventKind[] = ['observation-start', 'gap', 'epoch-reset'];

const ANNOTATION_KINDS: readonly SessionAnnotation['kind'][] = [
  'observation-started',
  'senders-milestone',
  'first-known-gap',
  'activity-spike',
  'new-room-active',
];

/**
 * Validate an unknown parsed JSON value as an ObservationSession.
 *
 * Throws on anything structurally wrong. Individual malformed array entries are dropped
 * rather than repaired.
 */
export function parseSessionFile(value: unknown): ObservationSession {
  if (!isRecord(value)) throw new SessionImportError('session file is not an object');
  if (value.schemaVersion !== 1) {
    throw new SessionImportError('unsupported or missing schemaVersion (expected 1)');
  }
  if (value.provenance !== 'live' && value.provenance !== 'synthetic') {
    throw new SessionImportError('provenance must be "live" or "synthetic"');
  }
  const startedAt = num(value.startedAt);
  if (startedAt === null || startedAt <= 0) {
    throw new SessionImportError('startedAt must be a positive timestamp');
  }
  if (!Array.isArray(value.messages) || !Array.isArray(value.senders)) {
    throw new SessionImportError('session file is missing messages or senders');
  }
  if (value.messages.length > MAX_MESSAGES) {
    throw new SessionImportError('session file exceeds the supported message count');
  }
  if (value.senders.length > MAX_SENDERS) {
    throw new SessionImportError('session file exceeds the supported sender count');
  }

  const rooms: ObservedRoom[] = [];
  for (const r of Array.isArray(value.rooms) ? value.rooms : []) {
    if (!isRecord(r) || !isValidRoomName(r.room)) continue;
    rooms.push({
      room: r.room,
      cursor: num(r.cursor),
      firstObservedSeq: num(r.firstObservedSeq),
      lastObservedSeq: num(r.lastObservedSeq),
      latestFirstSeq: num(r.latestFirstSeq),
      latestLastSeq: num(r.latestLastSeq),
      messagesObserved: int(r.messagesObserved),
      knownMissingSequencePositions: int(r.knownMissingSequencePositions),
      gapCount: int(r.gapCount),
      lastPollAt: num(r.lastPollAt),
      generation: num(r.generation),
    });
  }

  const senders: ObservedSender[] = [];
  let lane = 0;
  for (const s of value.senders) {
    if (!isRecord(s) || typeof s.id !== 'string' || s.id.length === 0) continue;
    const id = s.id.slice(0, MAX_STRING);
    senders.push({
      id,
      label: str(s.label, 64) || id.slice(0, 24),
      didPresent: s.didPresent === true,
      firstObservedAt: int(s.firstObservedAt, startedAt),
      lastObservedAt: int(s.lastObservedAt, startedAt),
      messageCount: int(s.messageCount),
      roomsObserved: Array.isArray(s.roomsObserved)
        ? s.roomsObserved.filter(isValidRoomName).slice(0, 64)
        : [],
      latestRoom: isValidRoomName(s.latestRoom) ? s.latestRoom : '',
      lane: typeof s.lane === 'number' && Number.isFinite(s.lane) ? Math.trunc(s.lane) : lane,
    });
    lane++;
  }

  const knownSenders = new Set(senders.map((s) => s.id));
  const messages: ObservedMessage[] = [];
  for (const m of value.messages) {
    if (!isRecord(m) || !isValidRoomName(m.room)) continue;
    const sender = str(m.sender);
    if (!knownSenders.has(sender)) continue;
    const observedAt = num(m.observedAt);
    if (observedAt === null || observedAt <= 0) continue;
    messages.push({
      room: m.room,
      seq: int(m.seq),
      serverTimestamp: num(m.serverTimestamp),
      observedAt,
      sender,
      textLength: int(m.textLength),
      didPresent: m.didPresent === true,
      // Kept as an inert string. Length-bounded, never parsed, never rendered as markup.
      excerpt: str(m.excerpt, 200),
    });
  }
  messages.sort((a, b) => a.observedAt - b.observedAt);

  const coverageEvents: GapEvent[] = [];
  for (const e of Array.isArray(value.coverageEvents) ? value.coverageEvents : []) {
    if (!isRecord(e) || !isValidRoomName(e.room)) continue;
    const kind = COVERAGE_KINDS.find((k) => k === e.kind);
    if (!kind) continue;
    coverageEvents.push({
      kind,
      room: e.room,
      observedAt: int(e.observedAt, startedAt),
      previousCursor: num(e.previousCursor),
      expectedNextSeq: num(e.expectedNextSeq),
      firstReadableSeq: num(e.firstReadableSeq),
      // A gap is the only kind that may carry a nonzero count, and it can never be
      // negative: an imported file must not be able to fabricate coverage.
      missingSequencePositions:
        kind === 'gap' ? Math.max(0, int(e.missingSequencePositions)) : 0,
    });
  }

  const annotations: SessionAnnotation[] = [];
  for (const a of Array.isArray(value.annotations) ? value.annotations : []) {
    if (!isRecord(a)) continue;
    const kind = ANNOTATION_KINDS.find((k) => k === a.kind);
    if (!kind) continue;
    annotations.push({ kind, at: int(a.at, startedAt), label: str(a.label, 80) });
  }

  const gapCount = coverageEvents.filter((e) => e.kind === 'gap').length;
  const roomsWithActivity = new Set(messages.map((m) => m.room));

  return {
    schemaVersion: 1,
    provenance: value.provenance,
    startedAt,
    endedAt: num(value.endedAt),
    upstreamMainSha: str(value.upstreamMainSha, 40),
    rooms,
    messages,
    senders,
    coverageEvents,
    annotations,
    // Aggregates are recomputed from the validated arrays rather than trusted from the
    // file: a file must not be able to claim metrics its own data does not support.
    aggregates: {
      senders: senders.length,
      observations: messages.length,
      rooms: roomsWithActivity.size,
      knownGaps: gapCount,
      knownMissingSequencePositions: coverageEvents.reduce(
        (sum, e) => sum + e.missingSequencePositions,
        0,
      ),
      messagesPerMinute: 0,
      knownSessionCoverage: null,
    },
  };
}
