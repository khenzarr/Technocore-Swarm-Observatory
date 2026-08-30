'use client';

/**
 * The live swarm: the primary visualization.
 *
 * Every observed sender is one small beacon glyph standing in its room's territory. A
 * glyph brightens when an observation lands on it, throws a short pulse ring, then cools
 * back to dormant. Nothing moves on its own: all motion on this canvas corresponds to an
 * actual — or replayed — observation.
 *
 * One canvas, one requestAnimationFrame loop, no DOM per agent. The loop reads the
 * mutable session through a ref and derives everything it draws from `lib/swarmModel`, so
 * what appears on screen is exactly what a test can assert on.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ObservationSessionState } from '@/lib/session';
import type { ObservedSender } from '@/lib/types';
import { roomColor } from '@/lib/palette';
import {
  buildSwarmLayout,
  sampleSwarmState,
  type SwarmLayout,
  type SwarmState,
} from '@/lib/swarmModel';

const PAD_X = 18;
const PAD_TOP = 16;
const PAD_BOTTOM = 18;
/** Glyph radius bounds. The lower bound is what keeps a 1,000-sender field legible. */
const GLYPH_MIN = 1.9;
const GLYPH_MAX = 4.2;

export interface SwarmCanvasProps {
  session: ObservationSessionState;
  /** Bumped by the host on session mutation, so the layout is rebuilt. */
  version: number;
  /** The instant the swarm represents. Live clock or replay playhead. */
  now: number;
  roomFilter: string | null;
  /** Sender id under focus, or `null`. */
  focused: string | null;
  onFocus: (senderId: string | null) => void;
  paused: boolean;
}

interface Hover {
  x: number;
  y: number;
  sender: ObservedSender;
}

export default function SwarmCanvas(props: SwarmCanvasProps) {
  const { session, version, now, roomFilter, focused, onFocus, paused } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);

  const live = useRef({ session, now, roomFilter, focused, paused });
  live.current = { session, now, roomFilter, focused, paused };

  /**
   * Layout is rebuilt only when the session's shape changes, never per frame: rebuilding
   * per frame is what would make senders teleport as new ones arrive.
   */
  const layoutRef = useRef<{ layout: SwarmLayout; senders: number; rooms: number } | null>(null);
  const layoutFor = useCallback((s: ObservationSessionState): SwarmLayout => {
    const cached = layoutRef.current;
    if (cached && cached.senders === s.senders.size && cached.rooms === s.rooms.size) {
      return cached.layout;
    }
    const layout = buildSwarmLayout(s);
    layoutRef.current = { layout, senders: s.senders.size, rooms: s.rooms.size };
    return layout;
  }, []);

  // Reused across frames so a populated field does not allocate per sender per frame.
  const stateRef = useRef<SwarmState | null>(null);
  /** Screen geometry of the last frame, shared with hit-testing. */
  const geom = useRef({ x0: 0, y0: 0, w: 1, h: 1, glyph: GLYPH_MIN });

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const { session: s, now: at, roomFilter: filter, focused: focusId } = live.current;
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

    const layout = layoutFor(s);
    const state = sampleSwarmState(s, layout, at, {
      roomFilter: filter,
      into: stateRef.current ?? undefined,
    });
    stateRef.current = state;

    const fieldX = PAD_X;
    const fieldY = PAD_TOP;
    const fieldW = cssW - PAD_X * 2;
    const fieldH = cssH - PAD_TOP - PAD_BOTTOM;
    if (fieldW <= 0 || fieldH <= 0) return;

    // Glyph size falls with density, but never below the floor that survives video
    // compression at 1080p.
    const glyph = Math.max(
      GLYPH_MIN,
      Math.min(GLYPH_MAX, Math.sqrt((fieldW * fieldH) / Math.max(state.presentCount, 1)) * 0.14),
    );
    geom.current = { x0: fieldX, y0: fieldY, w: fieldW, h: fieldH, glyph };
    const px = (u: number) => fieldX + u * fieldW;
    const py = (v: number) => fieldY + v * fieldH;

    drawBackdrop(ctx, fieldX, fieldY, fieldW, fieldH);

    const focusSlot = focusId === null ? -1 : (layout.slotOf.get(focusId) ?? -1);
    const focusZone = focusSlot >= 0 ? layout.zone[focusSlot] : -1;
    const focusRooms =
      focusSlot >= 0 ? (s.senders.get(layout.ids[focusSlot])?.roomsObserved ?? []) : [];

    // ── room territories ───────────────────────────────────────────────
    for (let z = 0; z < layout.zones.length; z++) {
      const zone = layout.zones[z];
      if (filter !== null && zone.room !== filter) continue;
      if (zone.memberCount === 0 && zone.messagesObserved === 0) continue;
      const heat = state.zoneHeat[z] ?? 0;
      const color = roomColor(zone.room);
      const x = px(zone.x);
      const y = py(zone.y);
      const w = zone.w * fieldW;
      const h = zone.h * fieldH;
      const inFocusRoom = focusSlot < 0 || focusRooms.includes(zone.room);

      // A faint contour, brightening with the room's own activity: the territory reacts,
      // without competing with the glyphs inside it.
      ctx.strokeStyle = withAlpha(color, (inFocusRoom ? 0.13 : 0.05) + heat * 0.22);
      ctx.lineWidth = 1;
      roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 10);
      ctx.stroke();

      ctx.fillStyle = withAlpha(color, (inFocusRoom ? 0.014 : 0.006) + heat * 0.03);
      ctx.fill();

      // Room label: readable, but visually secondary to the swarm.
      ctx.font = '600 11px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = withAlpha(color, inFocusRoom ? 0.62 + heat * 0.3 : 0.2);
      ctx.fillText(zone.room.toUpperCase(), x + 9, y + 15);
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillStyle = withAlpha('#7d94a6', inFocusRoom ? 0.6 : 0.2);
      ctx.fillText(`${zone.memberCount} SENDERS`, x + 9, y + 28);
    }

    // ── dormant glyphs ─────────────────────────────────────────────────
    // Drawn as one flat pass: the observed-session population is the ecology, and it
    // stays visible even when live traffic is quiet.
    for (let i = 0; i < layout.count; i++) {
      if (state.present[i] === 0 || state.heat[i] > 0.02) continue;
      if (layout.zone[i] < 0) continue;
      const dim = focusSlot >= 0 && layout.zone[i] !== focusZone ? 0.06 : 0.24;
      ctx.fillStyle = withAlpha(roomColor(layout.zones[layout.zone[i]].room), dim);
      ctx.fillRect(px(layout.x[i]) - glyph * 0.4, py(layout.y[i]) - glyph * 0.4, glyph * 0.8, glyph * 0.8);
    }

    // ── active glyphs ──────────────────────────────────────────────────
    for (let i = 0; i < layout.count; i++) {
      const heat = state.heat[i];
      if (state.present[i] === 0 || heat <= 0.02 || layout.zone[i] < 0) continue;
      const color = roomColor(layout.zones[layout.zone[i]].room);
      const x = px(layout.x[i]);
      const y = py(layout.y[i]);
      const dimmed = focusSlot >= 0 && layout.zone[i] !== focusZone;
      const scale = dimmed ? 0.25 : 1;
      const r = glyph * (0.62 + heat * 0.55);

      // Glow: cheap radial wash, only for genuinely hot glyphs, so the field breathes
      // with activity instead of everywhere at once.
      if (heat > 0.35 && !dimmed) {
        ctx.fillStyle = withAlpha(color, 0.1 * heat);
        ctx.beginPath();
        ctx.arc(x, y, r * 3.1, 0, Math.PI * 2);
        ctx.fill();
      }

      // Core.
      ctx.fillStyle = withAlpha(color, (0.42 + heat * 0.58) * scale);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();

      // Activity notch: a short spur whose direction is fixed per sender, so a hot glyph
      // reads as an oriented beacon rather than a bigger dot.
      if (heat > 0.25 && glyph > 2.2) {
        const angle = notchAngle(layout.ids[i]);
        ctx.strokeStyle = withAlpha(color, (0.5 + heat * 0.5) * scale);
        ctx.lineWidth = Math.max(1, glyph * 0.32);
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(angle) * r, y + Math.sin(angle) * r);
        ctx.lineTo(x + Math.cos(angle) * (r + glyph * 1.5 * heat), y + Math.sin(angle) * (r + glyph * 1.5 * heat));
        ctx.stroke();
      }

      // DID present: an outer ring. Presence of a `did:key:` prefix and nothing more —
      // not identity, not trust.
      if (layout.didPresent[i] === 1 && heat > 0.15) {
        ctx.strokeStyle = withAlpha(color, 0.3 * heat * scale + 0.08);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x, y, r + glyph * 0.9, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Multi-room: a second, wider ring.
      if (layout.multiRoom[i] === 1 && heat > 0.25) {
        ctx.strokeStyle = withAlpha('#e6f1f7', 0.16 * heat * scale);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x, y, r + glyph * 1.8, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Pulse: one expanding ring per fresh observation.
      const pulse = state.pulse[i];
      if (pulse > 0 && !dimmed) {
        const grow = 1 - pulse;
        ctx.strokeStyle = withAlpha(color, 0.5 * pulse);
        ctx.lineWidth = Math.max(1, glyph * 0.28 * pulse);
        ctx.beginPath();
        ctx.arc(x, y, r + grow * glyph * 6, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // ── room transitions ───────────────────────────────────────────────
    // The same observed sender identifier appearing in another room. A short curved
    // streak, not a claim that anything physically moved.
    for (const streak of state.streaks) {
      const to = layout.zones[streak.toZone];
      if (!to) continue;
      const x1 = px(layout.x[streak.slot]);
      const y1 = py(layout.y[streak.slot]);
      const x2 = px(to.x + to.w / 2);
      const y2 = py(to.y + to.h / 2);
      const fade = 1 - streak.progress;
      ctx.strokeStyle = withAlpha('#e6f1f7', 0.2 * fade);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.quadraticCurveTo((x1 + x2) / 2, Math.min(y1, y2) - fieldH * 0.06, x2, y2);
      ctx.stroke();
    }

    // ── focus emphasis ─────────────────────────────────────────────────
    if (focusSlot >= 0 && layout.zone[focusSlot] >= 0) {
      const x = px(layout.x[focusSlot]);
      const y = py(layout.y[focusSlot]);
      ctx.strokeStyle = '#35e6ff';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(x, y, glyph * 3.4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - glyph * 5.4, y);
      ctx.lineTo(x - glyph * 4, y);
      ctx.moveTo(x + glyph * 4, y);
      ctx.lineTo(x + glyph * 5.4, y);
      ctx.stroke();
    }

    // ── field readout ──────────────────────────────────────────────────
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#4a5a68';
    ctx.fillText(
      `${state.presentCount.toLocaleString()} OBSERVED · ${state.activeCount.toLocaleString()} ACTIVE NOW`,
      fieldX + 2,
      cssH - 5,
    );
  }, [layoutFor]);

  useEffect(() => {
    let frame = 0;
    const tick = () => {
      draw();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [draw]);

  // A replaced session must not keep the previous session's layout.
  useEffect(() => {
    layoutRef.current = null;
    stateRef.current = null;
  }, [session]);

  /** Nearest glyph to the pointer, within a generous radius. */
  const hitTest = useCallback((clientX: number, clientY: number): Hover | null => {
    const canvas = canvasRef.current;
    const layout = layoutRef.current?.layout;
    if (!canvas || !layout) return null;
    const rect = canvas.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    const { x0, y0, w, h, glyph } = geom.current;
    const reach = Math.max(glyph * 3.5, 9);
    let best = -1;
    let bestDist = reach * reach;
    const state = stateRef.current;
    for (let i = 0; i < layout.count; i++) {
      if (layout.zone[i] < 0) continue;
      if (state && state.present[i] === 0) continue;
      const dx = x0 + layout.x[i] * w - mx;
      const dy = y0 + layout.y[i] * h - my;
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    if (best < 0) return null;
    const sender = live.current.session.senders.get(layout.ids[best]);
    return sender ? { x: mx, y: my, sender } : null;
  }, []);

  // ESC leaves focus mode.
  useEffect(() => {
    if (focused === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onFocus(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focused, onFocus]);

  const senderCount = session.senders.size;
  const emptyMessage = useMemo(() => {
    if (senderCount > 0) return null;
    return paused ? 'PAUSED — NO OBSERVATIONS YET' : 'AWAITING FIRST OBSERVATION';
  }, [senderCount, paused]);

  return (
    <div className="field swarm" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        onMouseMove={(e) => setHover(hitTest(e.clientX, e.clientY))}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => {
          const hit = hitTest(e.clientX, e.clientY);
          onFocus(hit && hit.sender.id !== focused ? hit.sender.id : null);
        }}
        aria-label={`Live swarm: ${senderCount} observed senders across ${session.rooms.size} rooms, ${session.messages.length} observations`}
        role="img"
        data-version={version}
      />
      {emptyMessage && (
        <div className="empty">
          <span>{emptyMessage}</span>
          <span style={{ color: 'var(--ink-faint)' }}>OBSERVED != COMPLETE</span>
        </div>
      )}
      {hover && <SenderCard hover={hover} wrap={wrapRef.current} />}
    </div>
  );
}

/** Sender inspection card. Every value is text; nothing here is ever markup. */
function SenderCard({ hover, wrap }: { hover: Hover; wrap: HTMLDivElement | null }) {
  const width = wrap?.clientWidth ?? 0;
  const height = wrap?.clientHeight ?? 0;
  const flipX = hover.x > width - 330;
  const flipY = hover.y > height - 210;
  const s = hover.sender;
  return (
    <div
      className="inspect"
      style={{
        left: flipX ? undefined : hover.x + 16,
        right: flipX ? width - hover.x + 16 : undefined,
        top: flipY ? undefined : hover.y + 14,
        bottom: flipY ? height - hover.y + 14 : undefined,
      }}
    >
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

/**
 * Field backdrop: a faint technical lattice and one scan rule.
 *
 * Structure without decoration — enough to read as an instrument surface, low enough in
 * contrast that it never competes with a glyph.
 */
function drawBackdrop(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const step = 46;
  ctx.strokeStyle = 'rgba(22,32,44,0.55)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let gx = x; gx <= x + w; gx += step) {
    ctx.moveTo(Math.round(gx) + 0.5, y);
    ctx.lineTo(Math.round(gx) + 0.5, y + h);
  }
  for (let gy = y; gy <= y + h; gy += step) {
    ctx.moveTo(x, Math.round(gy) + 0.5);
    ctx.lineTo(x + w, Math.round(gy) + 0.5);
  }
  ctx.stroke();
}

/** Fixed per-sender notch direction, so a beacon's orientation never flickers. */
function notchAngle(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 360) * (Math.PI / 180);
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** `#rrggbb` plus alpha, as an `rgba()` string. */
function withAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
}
