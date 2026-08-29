'use client';

/**
 * The swarm field: the primary visualization.
 *
 * Time runs left to right; each observed sender holds a stable lane for the life of the
 * session. An observation is a mark on that sender's lane, coloured by room, with a trail
 * connecting a sender's first and last observation so a long-lived sender reads as a
 * continuous thread rather than scattered dust.
 *
 * Everything is drawn on one canvas from a single requestAnimationFrame loop, reading the
 * mutable session directly. Observations never become React state and never become DOM
 * nodes, which is what keeps tens of thousands of marks affordable.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ObservationSessionState } from '@/lib/session';
import type { GapEvent, ObservedSender } from '@/lib/types';
import { GAP_COLOR, START_COLOR, roomColor } from '@/lib/palette';
import {
  collectVisibleCoverageEvents,
  collectVisibleMarks,
  collectVisibleTrails,
  createMarkBuffer,
  laneCount as laneCountOf,
} from '@/lib/renderModel';


const LEFT_PAD = 8;
const RIGHT_PAD = 8;
const TOP_PAD = 10;
const BOTTOM_PAD = 22;
/**
 * Marks are sized for a 1080p screen recording rather than for a close look at a monitor:
 * a single observation has to survive video encoding, so nothing is ever drawn thinner
 * than about two device pixels at this scale.
 */
const MARK_MIN_HEIGHT = 2;
const MARK_WIDTH = 3.2;


export interface SwarmFieldProps {
  session: ObservationSessionState;
  /** Bumped by the host on session mutation, so the field re-reads bounds. */
  version: number;
  /** Right edge of the time window. */
  now: number;
  /** Width of the visible time window, in ms. */
  windowMs: number;
  /** `null` shows every room. */
  roomFilter: string | null;
  paused: boolean;
}

type Hover =
  | { kind: 'sender'; x: number; y: number; sender: ObservedSender }
  | { kind: 'coverage'; x: number; y: number; event: GapEvent }
  | null;

export default function SwarmField(props: SwarmFieldProps) {
  const { session, version, now, windowMs, roomFilter, paused } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover>(null);
  const [pinned, setPinned] = useState(false);

  // Latest props for the animation loop, which must not restart on every prop change.
  const live = useRef({ session, now, windowMs, roomFilter, paused, version });
  live.current = { session, now, windowMs, roomFilter, paused, version };

  /** Lane geometry, recomputed per frame. Shared with hit-testing. */
  const geom = useRef({ laneCount: 1, height: 0, width: 0, t0: 0, t1: 1 });
  /** Reused per frame so a populated field does not allocate per mark. */
  const marks = useRef(createMarkBuffer());


  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const { session: s, now: rightEdge, windowMs: span, roomFilter: filter } = live.current;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight;
    if (cssWidth === 0 || cssHeight === 0) return;
    if (canvas.width !== Math.round(cssWidth * dpr) || canvas.height !== Math.round(cssHeight * dpr)) {
      canvas.width = Math.round(cssWidth * dpr);
      canvas.height = Math.round(cssHeight * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const t1 = rightEdge;
    const t0 = t1 - span;
    const plotW = cssWidth - LEFT_PAD - RIGHT_PAD;
    const plotH = cssHeight - TOP_PAD - BOTTOM_PAD;
    const xOf = (t: number) => LEFT_PAD + ((t - t0) / span) * plotW;

    // The window this frame draws. Everything visible is derived from it through the
    // render model, so what the canvas draws is exactly what a test can assert on.
    const view = { now: t1, windowMs: span, roomFilter: filter };

    // Lanes are assignment-ordered, so a sender never jumps as new senders appear.

    const laneCount = laneCountOf(s);
    const laneH = plotH / laneCount;

    const yOf = (lane: number) => TOP_PAD + lane * laneH + laneH / 2;
    geom.current = { laneCount, height: cssHeight, width: cssWidth, t0, t1 };

    // ── time grid ──────────────────────────────────────────────────────
    ctx.strokeStyle = '#101a24';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#3a4b5a';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    const gridStep = niceStep(span);
    for (let t = Math.ceil(t0 / gridStep) * gridStep; t <= t1; t += gridStep) {
      const x = Math.round(xOf(t)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, TOP_PAD);
      ctx.lineTo(x, TOP_PAD + plotH);
      ctx.stroke();
      ctx.fillText(clockLabel(t), x, cssHeight - 8);
    }

    // ── sender trails ──────────────────────────────────────────────────
    // A faint line from first to last observation gives the field its structure and makes
    // an idle sender visibly idle rather than absent.
    ctx.lineWidth = Math.max(1, Math.min(laneH * 0.5, 1.8));
    for (const trail of collectVisibleTrails(s, view)) {
      const y = Math.round(yOf(trail.lane)) + 0.5;
      ctx.strokeStyle = withAlpha(roomColor(trail.room), 0.34);

      ctx.beginPath();
      ctx.moveTo(xOf(trail.from), y);
      ctx.lineTo(xOf(trail.to), y);
      ctx.stroke();
      // Lead dot at the sender's first observation: where this thread enters the session.
      if (trail.entersHere) {
        ctx.fillStyle = withAlpha(roomColor(trail.room), 0.9);
        ctx.fillRect(xOf(trail.from) - 1.5, y - 2, 3.5, 4);
      }
    }

    // ── observation marks ──────────────────────────────────────────────
    const markH = Math.max(MARK_MIN_HEIGHT, Math.min(laneH * 0.9, 4));
    const markW = MARK_WIDTH;

    marks.current = collectVisibleMarks(s, view, marks.current);
    const buffer = marks.current;
    for (let i = 0; i < buffer.count; i++) {
      const at = buffer.observedAt[i];
      // Recent marks burn brighter, which is what gives the live edge its motion.
      const age = (t1 - at) / span;
      // Recency is a strong cue but never fades an older mark below readable: the whole
      // window has to stay legible in a recording, not just the live edge.
      const alpha = 0.5 + 0.5 * Math.pow(1 - age, 3);

      ctx.fillStyle = withAlpha(roomColor(buffer.room[i]), alpha);
      ctx.fillRect(xOf(at) - markW / 2, yOf(buffer.lane[i]) - markH / 2, markW, markH);
    }

    // ── coverage events ────────────────────────────────────────────────
    // Drawn last so they are never buried by activity, and in a colour no room can use.
    for (const event of collectVisibleCoverageEvents(s, view)) {
      const x = xOf(event.observedAt);

      if (event.kind === 'gap') {
        // A band, not a line: a gap is an interval of unavailable sequence positions.
        const w = Math.max(3, Math.min(10, plotW * 0.004));
        const grad = ctx.createLinearGradient(x - w, 0, x + w, 0);
        grad.addColorStop(0, withAlpha(GAP_COLOR, 0));
        grad.addColorStop(0.5, withAlpha(GAP_COLOR, 0.42));
        grad.addColorStop(1, withAlpha(GAP_COLOR, 0));
        ctx.fillStyle = grad;
        ctx.fillRect(x - w, TOP_PAD, w * 2, plotH);
        ctx.strokeStyle = withAlpha(GAP_COLOR, 0.9);
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, TOP_PAD);
        ctx.lineTo(Math.round(x) + 0.5, TOP_PAD + plotH);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        // Observation start and epoch reset are boundaries of the coverage claim, not
        // failures, so they get a thin amber rule and no band.
        ctx.strokeStyle = withAlpha(START_COLOR, 0.5);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, TOP_PAD);
        ctx.lineTo(Math.round(x) + 0.5, TOP_PAD + plotH);
        ctx.stroke();
      }
    }

    // Live edge marker.
    ctx.fillStyle = withAlpha('#35e6ff', 0.55);
    ctx.fillRect(LEFT_PAD + plotW - 1, TOP_PAD, 1, plotH);
  }, []);

  // Single animation loop for the life of the component.
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      draw();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [draw]);

  /** Hit-test the pointer against coverage events first, then sender lanes. */
  const hitTest = useCallback(
    (clientX: number, clientY: number): Hover => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      const { laneCount, t0, t1 } = geom.current;
      const plotW = rect.width - LEFT_PAD - RIGHT_PAD;
      const plotH = rect.height - TOP_PAD - BOTTOM_PAD;
      if (plotW <= 0 || plotH <= 0) return null;
      const span = t1 - t0;
      const tAt = t0 + ((px - LEFT_PAD) / plotW) * span;

      const filter = live.current.roomFilter;
      const tolerance = (12 / plotW) * span;
      let bestEvent: GapEvent | null = null;
      let bestDelta = Infinity;
      for (const event of live.current.session.coverageEvents) {
        if (filter !== null && event.room !== filter) continue;
        const delta = Math.abs(event.observedAt - tAt);
        if (delta < tolerance && delta < bestDelta) {
          bestDelta = delta;
          bestEvent = event;
        }
      }
      if (bestEvent) return { kind: 'coverage', x: px, y: py, event: bestEvent };

      const laneH = plotH / laneCount;
      const lane = Math.floor((py - TOP_PAD) / laneH);
      if (lane < 0 || lane >= laneCount) return null;
      // Widen the pick radius when lanes are thinner than the pointer is precise.
      const laneSlack = laneH < 3 ? Math.ceil(3 / laneH) : 0;
      let best: ObservedSender | null = null;
      let bestScore = Infinity;
      for (const sender of live.current.session.senders.values()) {
        if (Math.abs(sender.lane - lane) > laneSlack) continue;
        if (filter !== null && !sender.roomsObserved.includes(filter)) continue;
        // Prefer a sender whose observed span actually contains the pointer time.
        const inSpan = tAt >= sender.firstObservedAt && tAt <= sender.lastObservedAt;
        const score = Math.abs(sender.lane - lane) + (inSpan ? 0 : 0.5);
        if (score < bestScore) {
          bestScore = score;
          best = sender;
        }
      }
      return best ? { kind: 'sender', x: px, y: py, sender: best } : null;
    },
    [],
  );

  const onMove = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      if (pinned) return;
      setHover(hitTest(event.clientX, event.clientY));
    },
    [hitTest, pinned],
  );

  const onClick = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      const hit = hitTest(event.clientX, event.clientY);
      setHover(hit);
      setPinned(hit !== null);
    },
    [hitTest],
  );

  const senderCount = session.senders.size;
  const emptyMessage = useMemo(() => {
    if (senderCount > 0) return null;
    return paused ? 'PAUSED — NO OBSERVATIONS YET' : 'AWAITING FIRST OBSERVATION';
  }, [senderCount, paused]);

  return (
    <div className="field" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        onMouseMove={onMove}
        onMouseLeave={() => !pinned && setHover(null)}
        onClick={onClick}
        aria-label={`Swarm field: ${senderCount} observed senders, ${session.messages.length} observations`}
        role="img"
      />
      <span className="axis-label">TIME →</span>
      {emptyMessage && (
        <div className="empty">
          <span>{emptyMessage}</span>
          <span style={{ color: 'var(--ink-faint)' }}>OBSERVED != COMPLETE</span>
        </div>
      )}
      {hover && <InspectCard hover={hover} wrap={wrapRef.current} />}
    </div>
  );
}

/** Inspection card. Every value is rendered as text; nothing here is ever markup. */
function InspectCard({ hover, wrap }: { hover: NonNullable<Hover>; wrap: HTMLDivElement | null }) {
  const width = wrap?.clientWidth ?? 0;
  const height = wrap?.clientHeight ?? 0;
  const style: React.CSSProperties = {
    left: hover.x > width - 350 ? undefined : hover.x + 14,
    right: hover.x > width - 350 ? width - hover.x + 14 : undefined,
    top: hover.y > height - 200 ? undefined : hover.y + 12,
    bottom: hover.y > height - 200 ? height - hover.y + 12 : undefined,
  };

  if (hover.kind === 'coverage') {
    const e = hover.event;
    const isGap = e.kind === 'gap';
    return (
      <div className="inspect" data-kind={isGap ? 'gap' : 'start'} style={style}>
        <h4>{isGap ? 'KNOWN OBSERVATION GAP' : e.kind === 'epoch-reset' ? 'ROOM EPOCH RESET' : 'OBSERVATION STARTED'}</h4>
        <dl>
          <dt>Room</dt>
          <dd>{e.room}</dd>
          <dt>Previous cursor</dt>
          <dd>{e.previousCursor ?? '—'}</dd>
          <dt>Expected next</dt>
          <dd>{e.expectedNextSeq ?? '—'}</dd>
          <dt>First readable</dt>
          <dd>{e.firstReadableSeq ?? '—'}</dd>
          {isGap && (
            <>
              <dt>Unavailable seq positions</dt>
              <dd>{e.missingSequencePositions.toLocaleString()}</dd>
            </>
          )}
          <dt>Observed at</dt>
          <dd>{new Date(e.observedAt).toLocaleTimeString()}</dd>
        </dl>
        <p>
          {isGap
            ? 'This observer detected that the readable Technocore window had advanced beyond its previous cursor. The count is sequence positions, not a count of lost messages.'
            : e.kind === 'epoch-reset'
              ? 'This room name now carries a different conversation, so the previous cursor no longer describes it. This is not a delivery gap.'
              : 'Activity before this point is outside this session\u2019s coverage claim.'}
        </p>
      </div>
    );
  }

  const s = hover.sender;
  return (
    <div className="inspect" style={style}>
      <h4>Observed sender</h4>
      <dl>
        <dt>Sender</dt>
        <dd>{s.label}</dd>
        <dt>First observed</dt>
        <dd>{new Date(s.firstObservedAt).toLocaleTimeString()}</dd>
        <dt>Last observed</dt>
        <dd>{new Date(s.lastObservedAt).toLocaleTimeString()}</dd>
        <dt>Messages observed</dt>
        <dd>{s.messageCount.toLocaleString()}</dd>
        <dt>Rooms observed</dt>
        <dd>{s.roomsObserved.length}</dd>
        <dt>Latest room</dt>
        <dd>{s.latestRoom}</dd>
        <dt>DID present</dt>
        <dd>{s.didPresent ? 'YES' : 'NO'}</dd>
      </dl>
      <p>A session-local label. Not an identity, reputation or trust claim.</p>
    </div>
  );
}

/** Pick a round grid interval for the current span. */
function niceStep(span: number): number {
  const candidates = [
    1_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000,
  ];
  for (const c of candidates) {
    if (span / c <= 9) return c;
  }
  return 7_200_000;
}

function clockLabel(t: number): string {
  const d = new Date(t);
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${String(d.getHours()).padStart(2, '0')}:${mm}:${ss}`;
}

/** `#rrggbb` plus alpha, as an `rgba()` string. */
function withAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
}
