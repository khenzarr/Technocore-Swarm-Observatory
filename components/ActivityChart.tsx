'use client';

/**
 * Historical activity: observations per time bucket, stacked by room.
 *
 * Two questions, one surface: when did activity spike, and which rooms drove it. It is
 * also the replay navigation surface — the playhead lives here, and clicking or dragging
 * the chart moves it, which moves the swarm above.
 *
 * Coverage markers are drawn on the same time axis, with the three kinds kept visually
 * distinct: a gap is missing coverage, an epoch reset is not, and the observation-start
 * rule is the edge of what this session claims to know.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ObservationSessionState } from '@/lib/session';
import { roomColor } from '@/lib/palette';
import {
  OTHER_SERIES,
  roomActivityBuckets,
  timelineMarkers,
  type ActivityStack,
  type TimelineMarker,
} from '@/lib/swarmModel';

const PAD_L = 46;
const PAD_R = 14;
const PAD_T = 16;
const PAD_B = 20;
/** Pointer distance, in px, within which a marker is considered hovered. */
const MARKER_REACH = 5;

export interface ActivityChartProps {
  session: ObservationSessionState;
  version: number;
  /** Current replay/live instant, drawn as the playhead. */
  now: number;
  roomFilter: string | null;
  /** Called on click/drag over the chart. Absent when scrubbing is unavailable. */
  onScrub?: (at: number) => void;
}

type Tip =
  | { kind: 'marker'; x: number; y: number; marker: TimelineMarker }
  | { kind: 'bucket'; x: number; y: number; at: number; rows: Array<[string, number]> };

export default function ActivityChart(props: ActivityChartProps) {
  const { session, version, now, roomFilter, onScrub } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const dragging = useRef(false);

  /*
   * Rebucketing walks the whole message log, so it is memoized rather than run per frame.
   * `version` is the ingestion counter: the session is a mutable accumulator, so its identity
   * does not change when observations land, and the counter is what makes these recompute.
   */
  const stack: ActivityStack = useMemo(
    () => roomActivityBuckets(session, { buckets: 220, topRooms: 6, colorOf: roomColor }),
    [session, version],
  );
  const markers = useMemo(
    () => timelineMarkers(session, { roomFilter }),
    [session, version, roomFilter],
  );

  const geom = useRef({ x0: PAD_L, w: 1, t0: 0, t1: 1 });
  const timeAt = useCallback((clientX: number): number => {
    const canvas = canvasRef.current;
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    const { x0, w, t0, t1 } = geom.current;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left - x0) / w));
    return t0 + ratio * (t1 - t0);
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (cssW === 0 || cssH === 0) return;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const x0 = PAD_L;
    const w = cssW - PAD_L - PAD_R;
    const y0 = PAD_T;
    const h = cssH - PAD_T - PAD_B;
    if (w <= 0 || h <= 0) return;
    const { t0, t1, peak, bucketStarts, bucketMs, series } = stack;
    geom.current = { x0, w, t0, t1 };
    const tx = (t: number) => x0 + ((t - t0) / (t1 - t0)) * w;
    const scale = peak > 0 ? h / peak : 0;

    // Baseline + a single mid gridline. Two rules are enough to read magnitude.
    ctx.strokeStyle = 'rgba(22,32,44,0.9)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, y0 + h + 0.5);
    ctx.lineTo(x0 + w, y0 + h + 0.5);
    ctx.moveTo(x0, y0 + h / 2 + 0.5);
    ctx.lineTo(x0 + w, y0 + h / 2 + 0.5);
    ctx.stroke();

    ctx.font = '10px ui-monospace, monospace';
    ctx.fillStyle = '#4a5a68';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(peak), x0 - 8, y0 + 2);
    ctx.fillText(String(Math.round(peak / 2)), x0 - 8, y0 + h / 2);
    ctx.fillText('0', x0 - 8, y0 + h);
    ctx.textAlign = 'left';
    ctx.fillText('OBS/BUCKET', 4, y0 + h + 12);

    // Stacked areas, densest room at the bottom so the busy rooms form a stable base.
    const baseline = new Float64Array(bucketStarts.length);
    for (const s of series) {
      ctx.beginPath();
      for (let b = 0; b < bucketStarts.length; b++) {
        const x = tx(bucketStarts[b] + bucketMs / 2);
        const y = y0 + h - (baseline[b] + s.values[b]) * scale;
        if (b === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      for (let b = bucketStarts.length - 1; b >= 0; b--) {
        ctx.lineTo(tx(bucketStarts[b] + bucketMs / 2), y0 + h - baseline[b] * scale);
      }
      ctx.closePath();
      ctx.fillStyle = withAlpha(s.color, s.room === OTHER_SERIES ? 0.3 : 0.45);
      ctx.fill();
      ctx.strokeStyle = withAlpha(s.color, 0.85);
      ctx.lineWidth = 1;
      ctx.stroke();
      for (let b = 0; b < bucketStarts.length; b++) baseline[b] += s.values[b];
    }

    // ── coverage markers ───────────────────────────────────────────────
    for (const marker of markers) {
      const x = Math.round(tx(marker.at)) + 0.5;
      if (x < x0 || x > x0 + w) continue;
      const style = MARKER_STYLE[marker.kind];
      ctx.strokeStyle = style.line;
      ctx.lineWidth = 1;
      if (style.dashed) ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, y0 - 6);
      ctx.lineTo(x, y0 + h);
      ctx.stroke();
      ctx.setLineDash([]);
      // Top cap: shape carries the kind, so the three are distinguishable without colour.
      ctx.fillStyle = style.cap;
      if (marker.kind === 'gap') {
        ctx.fillRect(x - 2.5, y0 - 10, 5, 5);
      } else if (marker.kind === 'epoch-reset') {
        ctx.beginPath();
        ctx.moveTo(x, y0 - 11);
        ctx.lineTo(x + 3.5, y0 - 5);
        ctx.lineTo(x - 3.5, y0 - 5);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(x, y0 - 7.5, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ── playhead ───────────────────────────────────────────────────────
    const headX = Math.round(tx(Math.max(t0, Math.min(t1, now)))) + 0.5;
    ctx.strokeStyle = '#35e6ff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(headX, y0 - 12);
    ctx.lineTo(headX, y0 + h);
    ctx.stroke();
    ctx.fillStyle = '#35e6ff';
    ctx.beginPath();
    ctx.moveTo(headX, y0 - 5);
    ctx.lineTo(headX + 4, y0 - 12);
    ctx.lineTo(headX - 4, y0 - 12);
    ctx.closePath();
    ctx.fill();

    // Axis ends, plus the playhead's own clock.
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillStyle = '#4a5a68';
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillText(clock(t0), x0, y0 + h + 14);
    ctx.textAlign = 'right';
    ctx.fillText(clock(t1), x0 + w, y0 + h + 14);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#35e6ff';
    ctx.fillText(clock(now), Math.max(x0 + 30, Math.min(x0 + w - 30, headX)), y0 + h + 14);
  }, [stack, markers, now]);

  useEffect(() => {
    let frame = 0;
    const tick = () => {
      draw();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [draw]);

  /** Marker under the pointer wins over the bucket readout: it carries more meaning. */
  const inspect = useCallback(
    (clientX: number, clientY: number): Tip | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const mx = clientX - rect.left;
      const my = clientY - rect.top;
      const { x0, w, t0, t1 } = geom.current;
      const tx = (t: number) => x0 + ((t - t0) / (t1 - t0)) * w;

      let nearest: TimelineMarker | null = null;
      let nearestDist = MARKER_REACH;
      for (const marker of markers) {
        const dist = Math.abs(tx(marker.at) - mx);
        if (dist < nearestDist) {
          nearestDist = dist;
          nearest = marker;
        }
      }
      if (nearest) return { kind: 'marker', x: mx, y: my, marker: nearest };

      const at = t0 + Math.max(0, Math.min(1, (mx - x0) / w)) * (t1 - t0);
      const b = Math.min(
        Math.max(Math.floor((at - stack.t0) / stack.bucketMs), 0),
        stack.bucketStarts.length - 1,
      );
      const rows = stack.series
        .map((s) => [s.room, s.values[b]] as [string, number])
        .filter(([, v]) => v > 0)
        .sort((a, b2) => b2[1] - a[1]);
      if (rows.length === 0) return null;
      return { kind: 'bucket', x: mx, y: my, at: stack.bucketStarts[b], rows };
    },
    [markers, stack],
  );

  const scrubTo = useCallback(
    (clientX: number) => {
      if (!onScrub) return;
      onScrub(timeAt(clientX));
    },
    [onScrub, timeAt],
  );

  return (
    <div className="chart" ref={wrapRef} data-scrubbable={onScrub ? 'true' : 'false'}>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`Observations per time bucket by room. ${stack.total} observations, ${markers.length} coverage markers.`}
        onPointerDown={(e) => {
          if (!onScrub) return;
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          scrubTo(e.clientX);
        }}
        onPointerMove={(e) => {
          if (dragging.current) scrubTo(e.clientX);
          setTip(inspect(e.clientX, e.clientY));
        }}
        onPointerUp={(e) => {
          dragging.current = false;
          if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
          }
        }}
        onPointerLeave={() => {
          dragging.current = false;
          setTip(null);
        }}
      />
      {tip && <ChartTip tip={tip} wrap={wrapRef.current} />}
    </div>
  );
}

function ChartTip({ tip, wrap }: { tip: Tip; wrap: HTMLDivElement | null }) {
  const width = wrap?.clientWidth ?? 0;
  const flipX = tip.x > width - 320;
  const style = {
    left: flipX ? undefined : tip.x + 14,
    right: flipX ? width - tip.x + 14 : undefined,
    bottom: 12,
  } as const;

  if (tip.kind === 'bucket') {
    return (
      <div className="inspect" style={style}>
        <h4>{clock(tip.at)}</h4>
        <dl>
          {tip.rows.map(([room, value]) => (
            <div key={room} style={{ display: 'contents' }}>
              <dt>{room}</dt>
              <dd>{value.toLocaleString()}</dd>
            </div>
          ))}
        </dl>
      </div>
    );
  }

  const { marker } = tip;
  const e = marker.event;
  if (marker.kind === 'observation-start') {
    return (
      <div className="inspect" data-kind="start" style={style}>
        <h4>Observation started</h4>
        <dl>
          <dt>Room</dt>
          <dd>{e.room}</dd>
          <dt>Observed at</dt>
          <dd>{clock(e.observedAt)}</dd>
        </dl>
        <p>Activity before this point is outside this session&apos;s coverage claim.</p>
      </div>
    );
  }
  if (marker.kind === 'epoch-reset') {
    return (
      <div className="inspect" data-kind="start" style={style}>
        <h4>Room generation reset</h4>
        <dl>
          <dt>Room</dt>
          <dd>{e.room}</dd>
          <dt>Expected next</dt>
          <dd>{seq(e.expectedNextSeq)}</dd>
          <dt>First readable</dt>
          <dd>{seq(e.firstReadableSeq)}</dd>
          <dt>Observed at</dt>
          <dd>{clock(e.observedAt)}</dd>
        </dl>
        <p>The room restarted its sequence. This is not missing coverage.</p>
      </div>
    );
  }
  return (
    <div className="inspect" data-kind="gap" style={style}>
      <h4>Known observation gap</h4>
      <dl>
        <dt>Room</dt>
        <dd>{e.room}</dd>
        <dt>Expected next</dt>
        <dd>{seq(e.expectedNextSeq)}</dd>
        <dt>First readable</dt>
        <dd>{seq(e.firstReadableSeq)}</dd>
        <dt>Unavailable positions</dt>
        <dd>{e.missingSequencePositions.toLocaleString()}</dd>
        <dt>Observed at</dt>
        <dd>{clock(e.observedAt)}</dd>
      </dl>
      <p>Sequence positions this observer could not read. Their content is unknown.</p>
    </div>
  );
}

const MARKER_STYLE: Record<string, { line: string; cap: string; dashed: boolean }> = {
  gap: { line: 'rgba(255,63,111,0.55)', cap: '#ff3f6f', dashed: false },
  'epoch-reset': { line: 'rgba(255,179,71,0.5)', cap: '#ffb347', dashed: true },
  'observation-start': { line: 'rgba(125,148,166,0.4)', cap: '#7d94a6', dashed: true },
};

/** A sequence position, or an explicit dash when the observer never held one. */
function seq(value: number | null): string {
  return value === null ? '—' : String(value);
}

function clock(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour12: false });
}

function withAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
