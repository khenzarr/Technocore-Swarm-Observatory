/**
 * Data model for the Technocore Swarm Observatory.
 *
 * Everything here describes what THIS observer saw. Nothing here is a claim about
 * complete Technocore history, and nothing here is an identity claim about a sender.
 */

/** Where a dataset came from. Live and synthetic data must never be merged. */
export type Provenance = 'live' | 'synthetic';

export type ObservatoryMode = 'live' | 'paused' | 'replay' | 'synthetic';

/**
 * A sender as this session sees it.
 *
 * `id` is a session-stable key derived from the protocol's `from` field. It is not a
 * person, not an account, and not a verified agent.
 */
export interface ObservedSender {
  /** Session-stable key. Equal to the raw protocol `from` value. */
  id: string;
  /** Short display form. A DID is abbreviated; a nickname is shown with a `~` marker. */
  label: string;
  /** True only when the protocol's `from` value literally begins with `did:key:`. */
  didPresent: boolean;
  firstObservedAt: number;
  lastObservedAt: number;
  messageCount: number;
  /** Rooms this session observed this sender in. */
  roomsObserved: string[];
  latestRoom: string;
  /** Stable vertical lane assigned on first observation. */
  lane: number;
}

/**
 * One observed message. The body is deliberately not retained in full: this product is
 * activity observability, not message surveillance.
 */
export interface ObservedMessage {
  room: string;
  seq: number;
  /** Server-assigned `ts`, parsed to epoch millis. Null when unparseable. */
  serverTimestamp: number | null;
  /** When this observer received it. */
  observedAt: number;
  sender: string;
  textLength: number;
  didPresent: boolean;
  /** Short, inert excerpt for the inspection card. Never rendered as HTML. */
  excerpt: string;
}

export interface ObservedRoom {
  room: string;
  /** Highest observed tail. NOT proof of contiguous delivery. */
  cursor: number | null;
  firstObservedSeq: number | null;
  lastObservedSeq: number | null;
  /** `first_seq` from the most recent non-empty read. */
  latestFirstSeq: number | null;
  /** `last_seq` from the most recent read. */
  latestLastSeq: number | null;
  messagesObserved: number;
  /** Count of sequence positions this observer knows it could not read. */
  knownMissingSequencePositions: number;
  gapCount: number;
  lastPollAt: number | null;
  /** Room lifetime epoch, when the deployment exposes one. */
  generation: number | null;
}

/**
 * A detected discontinuity in this observer's coverage.
 *
 * `observation-start` is NOT a gap. It marks the boundary of the session's coverage
 * claim: activity before it is simply outside what this session can speak about.
 *
 * `epoch-reset` is NOT a gap either. The room name now carries a different
 * conversation, so the previous cursor does not describe it.
 */
export type CoverageEventKind = 'observation-start' | 'gap' | 'epoch-reset';

export interface GapEvent {
  kind: CoverageEventKind;
  room: string;
  observedAt: number;
  /** The cursor held before this read. Null at observation start. */
  previousCursor: number | null;
  /** The sequence position the observer would have read next. Null at observation start. */
  expectedNextSeq: number | null;
  /** The lowest sequence the read could actually return. */
  firstReadableSeq: number | null;
  /**
   * Count of sequence positions between the cursor and the first readable sequence.
   *
   * Upstream does not guarantee one message per sequence position, so this is a count of
   * SEQUENCE POSITIONS, never a count of lost messages.
   */
  missingSequencePositions: number;
}

/** One fixed-width slice of the activity-rate series. */
export interface ActivityBucket {
  readonly startedAt: number;
  readonly count: number;
}

export type AnnotationKind =
  | 'observation-started'
  | 'senders-milestone'
  | 'first-known-gap'
  | 'activity-spike'
  | 'new-room-active';

export interface SessionAnnotation {
  kind: AnnotationKind;
  at: number;
  label: string;
}

/** Aggregates shown in the metrics strip. */
export interface SessionAggregates {
  senders: number;
  observations: number;
  rooms: number;
  knownGaps: number;
  knownMissingSequencePositions: number;
  messagesPerMinute: number;
  /**
   * Observed sequence positions divided by the sequence span this session actually
   * attempted to cover. It is a statement about the session only, never about
   * Technocore as a whole. Null when the denominator is not yet meaningful.
   */
  knownSessionCoverage: number | null;
}

export interface ObservationSession {
  schemaVersion: 1;
  provenance: Provenance;
  startedAt: number;
  endedAt: number | null;
  /** Upstream commit whose source this client's protocol assumptions were verified against. */
  upstreamMainSha: string;
  rooms: ObservedRoom[];
  messages: ObservedMessage[];
  senders: ObservedSender[];
  coverageEvents: GapEvent[];
  annotations: SessionAnnotation[];
  aggregates: SessionAggregates;
}
