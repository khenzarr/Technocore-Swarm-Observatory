'use client';

/**
 * AGENTS: the population view.
 *
 * The narrative counterpart to the swarm field. Every observed sender becomes one small
 * agent standing in its room's district, and the districts together read as a populated
 * scene rather than as a scatter plot. An agent idles with a slow bob, brightens and pops
 * when an observation lands on it, and a sampled few speak in short quote bubbles above
 * their heads.
 *
 * The same rules as the swarm canvas apply. One canvas, one requestAnimationFrame loop,
 * no DOM per agent. Everything drawn is derived from `lib/agentsModel`, which reads the
 * same observation session the rest of the app reads, so what is on screen is exactly
 * what a test can assert on. Motion that is not the idle bob always corresponds to a real
 * — or replayed — observation; the bob is the only ambient animation, and it carries no
 * information.
 *
 * Bubble text arrives pre-sanitized and pre-truncated from the model and is painted with
 * `fillText`. It is never markup, never parsed, and no URL in it is ever followed.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ObservationSessionState } from '@/lib/session';
import type { ObservedSender } from '@/lib/types';
import { roomColor } from '@/lib/palette';
import {
  buildAgentsLayout,
  sampleAgentBubbles,
  sampleAgentsState,
  type AgentBubble,
  type AgentsLayout,
  type AgentsState,
} from '@/lib/agentsModel';

const PAD_X = 14;
const PAD_TOP = 12;
const PAD_BOTTOM = 20;
/** Agent body half-width bounds, in CSS pixels. The floor survives 1080p compression. */
const AGENT_MIN = 2.4;
const AGENT_MAX = 7.5;
/** Below this body size the detailed minion is replaced by a simple lozenge. */
const DETAIL_THRESHOLD = 3.4;
/** Idle bob amplitude, as a multiple of body size. Deliberately small. */
const BOB = 0.34;

export interface AgentsStageProps {
  session: ObservationSessionState;
  /** Bumped by the host on session mutation, so the layout is rebuilt. */
  version: number;
  /** The instant the stage represents. Live clock or replay playhead. */
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

export default function AgentsStage(props: AgentsStageProps) {
  const { session, version, now, roomFilter, focused, onFocus, paused } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);

  const live = useRef({ session, now, roomFilter, focused, paused });
  live.current = { session, now, roomFilter, focused, paused };

  /**
   * Layout is rebuilt only when the session's shape changes, never per frame: rebuilding
   * per frame is what would make agents teleport as new ones arrive.
   */
  const layoutRef = useRef<{ layout: AgentsLayout; senders: number; rooms: number } | null>(null);
  const layoutFor = useCallback((s: ObservationSessionState): AgentsLayout => {
    const cached = layoutRef.current;
    if (cached && cached.senders === s.senders.size && cached.rooms === s.rooms.size) {
      return cached.layout;
    }
    const layout = buildAgentsLayout(s);
    layoutRef.current = { layout, senders: s.senders.size, rooms: s.rooms.size };
    return layout;
  }, []);

  // Reused across frames so a populated stage does not allocate per agent per frame.
  const stateRef = useRef<AgentsState | null>(null);
  /** Screen geometry of the last frame, shared with hit-testing. */
  const geom = useRef({ x0: 0, y0: 0, w: 1, h: 1, body: AGENT_MIN });
  /**
   * Bob clock. Frozen while paused, so PAUSE actually stops the stage instead of leaving
   * it breathing.
   */
  const bobClock = useRef(0);
  const lastFrameAt = useRef<number | null>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const { session: s, now: at, roomFilter: filter, focused: focusId, paused: isPaused } =
      live.current;

    const frameAt = performance.now();
    const delta = lastFrameAt.current === null ? 0 : frameAt - lastFrameAt.current;
    lastFrameAt.current = frameAt;
    if (!isPaused) bobClock.current += Math.min(delta, 64);

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
    const state = sampleAgentsState(s, layout, at, {
      roomFilter: filter,
      into: stateRef.current ?? undefined,
    });
    stateRef.current = state;
    const bubbles = sampleAgentBubbles(s, layout, at, { roomFilter: filter });

    const fieldX = PAD_X;
    const fieldY = PAD_TOP;
    const fieldW = cssW - PAD_X * 2;
    const fieldH = cssH - PAD_TOP - PAD_BOTTOM;
    if (fieldW <= 0 || fieldH <= 0) return;

    // Body size falls with density but never below the legibility floor. Districts, not
    // the whole stage, set the scale: a crowded room should not shrink a quiet one.
    const perDistrict = Math.max(
      1,
      Math.ceil(state.presentCount / Math.max(layout.districts.length, 1)),
    );
    const body = Math.max(
      AGENT_MIN,
      Math.min(
        AGENT_MAX,
        Math.sqrt(
          (fieldW * fieldH) / Math.max(layout.districts.length, 1) / Math.max(perDistrict, 1),
        ) * 0.2,
      ),
    );
    geom.current = { x0: fieldX, y0: fieldY, w: fieldW, h: fieldH, body };
    const px = (u: number) => fieldX + u * fieldW;
    const py = (v: number) => fieldY + v * fieldH;

    const focusSlot = focusId === null ? -1 : (layout.slotOf.get(focusId) ?? -1);
    const focusDistrict = focusSlot >= 0 ? layout.district[focusSlot] : -1;
    const detailed = body >= DETAIL_THRESHOLD;
    const t = bobClock.current / 1000;

    // ── districts ──────────────────────────────────────────────────────
    for (let d = 0; d < layout.districts.length; d++) {
      const district = layout.districts[d];
      if (filter !== null && district.room !== filter) continue;
      if (district.memberCount === 0 && district.messagesObserved === 0) continue;
      const heat = state.districtHeat[d] ?? 0;
      const color = roomColor(district.room);
      const x = px(district.x);
      const y = py(district.y);
      const w = district.w * fieldW;
      const h = district.h * fieldH;
      const inFocus = focusSlot < 0 || d === focusDistrict;

      // A shallow well with a floor gradient: enough to read as a lit stage, low enough
      // in contrast that it never competes with an agent.
      const wash = ctx.createLinearGradient(x, y, x, y + h);
      wash.addColorStop(0, withAlpha(color, (inFocus ? 0.03 : 0.012) + heat * 0.035));
      wash.addColorStop(1, withAlpha(color, 0.004));
      ctx.fillStyle = wash;
      roundRect(ctx, x, y, w, h, 12);
      ctx.fill();

      ctx.strokeStyle = withAlpha(color, (inFocus ? 0.16 : 0.05) + heat * 0.26);
      ctx.lineWidth = 1;
      roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 12);
      ctx.stroke();

      // Ground line: the visual cue that agents are standing somewhere.
      const groundY = Math.round(y + h * 0.945) + 0.5;
      ctx.strokeStyle = withAlpha(color, 0.1 + heat * 0.16);
      ctx.beginPath();
      ctx.moveTo(x + 10, groundY);
      ctx.lineTo(x + w - 10, groundY);
      ctx.stroke();

      // District label. Secondary to the population, but always readable.
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.font = '600 11px ui-monospace, monospace';
      ctx.fillStyle = withAlpha(color, inFocus ? 0.66 + heat * 0.3 : 0.22);
      ctx.fillText(district.room.toUpperCase(), x + 10, y + 16);
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillStyle = withAlpha('#7d94a6', inFocus ? 0.62 : 0.22);
      const overflowNote = district.overflow > 0 ? ` · +${district.overflow} OFF STAGE` : '';
      ctx.fillText(`${district.memberCount} AGENTS${overflowNote}`, x + 10, y + 29);
    }

    // ── agents ─────────────────────────────────────────────────────────
    // One pass, back rows first, so a foreground agent overlaps the one behind it and the
    // district reads as a crowd with depth.
    const order = drawOrder(layout);
    for (const i of order) {
      if (state.present[i] === 0) continue;
      const d = layout.district[i];
      if (d < 0 || layout.x[i] < 0) continue;

      const heat = state.heat[i];
      const pulse = state.pulse[i];
      const spawn = state.spawn[i];
      const dimmed = focusSlot >= 0 && d !== focusDistrict;
      const color = roomColor(layout.districts[d].room);

      // Depth: the back rows sit slightly smaller and dimmer.
      const depthScale = 0.78 + layout.depth[i] * 0.28;
      // Arrival: a new agent drops in and settles, which is what makes a growing session
      // visibly grow rather than silently gain dots.
      const spawnEase = spawn > 0 ? 1 - spawn * spawn : 1;
      const popScale = 1 + pulse * 0.42 + heat * 0.14;
      const r = body * depthScale * spawnEase * popScale;

      const x = px(layout.x[i]);
      const bobOffset = Math.sin(t * (1.1 + layout.depth[i] * 0.35) + layout.phase[i]) * r * BOB;
      const dropIn = spawn > 0 ? -spawn * spawn * body * 4.5 : 0;
      const y = py(layout.y[i]) + bobOffset + dropIn;

      const alpha =
        (0.2 + layout.depth[i] * 0.1 + heat * 0.72) * (dimmed ? 0.22 : 1) * (0.35 + spawnEase * 0.65);

      // Glow for genuinely active agents only, so the stage breathes with activity rather
      // than everywhere at once.
      if (heat > 0.3 && !dimmed) {
        ctx.fillStyle = withAlpha(color, 0.1 * heat);
        ctx.beginPath();
        ctx.arc(x, y, r * 3.4, 0, Math.PI * 2);
        ctx.fill();
      }

      // Contact shadow. Cheap, and it is what anchors the agent to the ground.
      if (detailed && !dimmed) {
        ctx.fillStyle = withAlpha('#000000', 0.3);
        ctx.beginPath();
        ctx.ellipse(x, py(layout.y[i]) + r * 1.5, r * 0.85, r * 0.3, 0, 0, Math.PI * 2);
        ctx.fill();
      }

      if (detailed) {
        drawAgent(ctx, x, y, r, color, alpha, heat, layout.didPresent[i] === 1);
      } else {
        // Low-detail fallback: a lozenge with a visor tick. Keeps a thousand-agent stage
        // affordable while still reading as a body rather than as a dot.
        ctx.fillStyle = withAlpha(color, alpha);
        roundRect(ctx, x - r * 0.62, y - r, r * 1.24, r * 2, r * 0.55);
        ctx.fill();
        if (heat > 0.2) {
          ctx.fillStyle = withAlpha('#e6f1f7', 0.5 * heat);
          ctx.fillRect(x - r * 0.36, y - r * 0.34, r * 0.72, Math.max(1, r * 0.26));
        }
      }

      // DID present: a thin halo. Literal `did:key:` prefix presence and nothing more —
      // not identity, not reputation, not trust.
      if (layout.didPresent[i] === 1 && (heat > 0.1 || detailed)) {
        ctx.strokeStyle = withAlpha(color, (0.1 + heat * 0.4) * (dimmed ? 0.25 : 1));
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse(x, y - r * 1.5, r * 0.8, r * 0.3, 0, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Multi-room: a wider ground ring. The same observed identifier appeared in more
      // than one room this session.
      if (layout.multiRoom[i] === 1 && heat > 0.18 && !dimmed) {
        ctx.strokeStyle = withAlpha('#e6f1f7', 0.2 * heat);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse(x, py(layout.y[i]) + r * 1.5, r * 1.5, r * 0.5, 0, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Pop ring: one per fresh observation.
      if (pulse > 0 && !dimmed) {
        const grow = 1 - pulse;
        ctx.strokeStyle = withAlpha(color, 0.55 * pulse);
        ctx.lineWidth = Math.max(1, r * 0.22 * pulse);
        ctx.beginPath();
        ctx.arc(x, y, r * (1.2 + grow * 4.2), 0, Math.PI * 2);
        ctx.stroke();
      }

      // Arrival flash, so a first observation is visibly a first observation.
      if (spawn > 0 && !dimmed) {
        ctx.strokeStyle = withAlpha('#e6f1f7', 0.4 * spawn);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x, y, r * (1.6 + (1 - spawn) * 2.4), 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // ── focus emphasis ─────────────────────────────────────────────────
    if (focusSlot >= 0 && layout.x[focusSlot] >= 0 && state.present[focusSlot] === 1) {
      const x = px(layout.x[focusSlot]);
      const y = py(layout.y[focusSlot]);
      ctx.strokeStyle = '#35e6ff';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(x, y, body * 3.6, 0, Math.PI * 2);
      ctx.stroke();
    }

    // ── quote bubbles ──────────────────────────────────────────────────
    // Drawn last so they always sit above the crowd. Sampled and capped by the model.
    for (const bubble of bubbles) {
      if (state.present[bubble.slot] === 0) continue;
      if (focusSlot >= 0 && layout.district[bubble.slot] !== focusDistrict) continue;
      drawBubble(ctx, bubble, px(layout.x[bubble.slot]), py(layout.y[bubble.slot]), body, fieldX, fieldW);
    }

    // ── stage readout ──────────────────────────────────────────────────
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#4a5a68';
    ctx.fillText(
      `${state.presentCount.toLocaleString()} OBSERVED AGENTS · ${state.activeCount.toLocaleString()} ACTIVE NOW · ${layout.districts.length.toLocaleString()} DISTRICTS`,
      fieldX + 2,
      cssH - 6,
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

  /** Nearest agent to the pointer, within a generous radius. */
  const hitTest = useCallback((clientX: number, clientY: number): Hover | null => {
    const canvas = canvasRef.current;
    const layout = layoutRef.current?.layout;
    if (!canvas || !layout) return null;
    const rect = canvas.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    const { x0, y0, w, h, body } = geom.current;
    const reach = Math.max(body * 3, 10);
    let best = -1;
    let bestDist = reach * reach;
    const state = stateRef.current;
    for (let i = 0; i < layout.count; i++) {
      if (layout.x[i] < 0) continue;
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
    return paused ? 'PAUSED — NO AGENTS OBSERVED YET' : 'AWAITING FIRST OBSERVATION';
  }, [senderCount, paused]);

  return (
    <div className="field agents" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        onMouseMove={(e) => setHover(hitTest(e.clientX, e.clientY))}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => {
          const hit = hitTest(e.clientX, e.clientY);
          onFocus(hit && hit.sender.id !== focused ? hit.sender.id : null);
        }}
        aria-label={`Agent population: ${senderCount} observed senders across ${session.rooms.size} rooms, ${session.messages.length} observations`}
        role="img"
        data-version={version}
      />
      {emptyMessage && (
        <div className="empty">
          <span>{emptyMessage}</span>
          <span style={{ color: 'var(--ink-faint)' }}>OBSERVED != COMPLETE</span>
        </div>
      )}
      {hover && <AgentCard hover={hover} wrap={wrapRef.current} />}
    </div>
  );
}

/**
 * Draw order: back rows first.
 *
 * Cached on the layout object, since it only changes when the layout is rebuilt.
 */
const orderCache = new WeakMap<AgentsLayout, Int32Array>();
function drawOrder(layout: AgentsLayout): Int32Array {
  const cached = orderCache.get(layout);
  if (cached) return cached;
  const order = Int32Array.from({ length: layout.count }, (_, i) => i);
  const sorted = Array.from(order).sort((a, b) => layout.y[a] - layout.y[b]);
  const result = Int32Array.from(sorted);
  orderCache.set(layout, result);
  return result;
}

/**
 * One agent: a rounded body, a visor band, a pair of ground ticks and — when active — a
 * small antenna. Primitives only; no sprites, no images, no per-agent DOM.
 */
function drawAgent(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  color: string,
  alpha: number,
  heat: number,
  did: boolean,
): void {
  // Legs: two short ticks. Read as "standing" at a glance.
  ctx.strokeStyle = withAlpha(color, alpha * 0.7);
  ctx.lineWidth = Math.max(1, r * 0.2);
  ctx.beginPath();
  ctx.moveTo(x - r * 0.34, y + r * 0.9);
  ctx.lineTo(x - r * 0.34, y + r * 1.45);
  ctx.moveTo(x + r * 0.34, y + r * 0.9);
  ctx.lineTo(x + r * 0.34, y + r * 1.45);
  ctx.stroke();

  // Body.
  ctx.fillStyle = withAlpha(color, alpha);
  roundRect(ctx, x - r * 0.72, y - r * 0.95, r * 1.44, r * 1.95, r * 0.62);
  ctx.fill();

  // Visor: a bright band across the head. The single feature that gives the glyph a face.
  ctx.fillStyle = withAlpha('#02040a', 0.55 + heat * 0.2);
  roundRect(ctx, x - r * 0.52, y - r * 0.5, r * 1.04, r * 0.46, r * 0.2);
  ctx.fill();
  ctx.fillStyle = withAlpha(heat > 0.25 ? '#e6f1f7' : color, 0.35 + heat * 0.65);
  roundRect(ctx, x - r * 0.42, y - r * 0.42, r * 0.84, r * 0.28, r * 0.14);
  ctx.fill();

  // Antenna: only while active, so a talking agent is distinguishable at a distance.
  if (heat > 0.22) {
    ctx.strokeStyle = withAlpha(color, 0.5 + heat * 0.5);
    ctx.lineWidth = Math.max(1, r * 0.16);
    ctx.beginPath();
    ctx.moveTo(x, y - r * 0.95);
    ctx.lineTo(x, y - r * 1.5);
    ctx.stroke();
    ctx.fillStyle = withAlpha('#e6f1f7', 0.4 + heat * 0.6);
    ctx.beginPath();
    ctx.arc(x, y - r * 1.62, Math.max(0.8, r * 0.2), 0, Math.PI * 2);
    ctx.fill();
  }

  // DID present: a small notch on the shoulder, in addition to the halo drawn by the
  // caller, so the distinction is not carried by a single faint ellipse alone.
  if (did && r > 4.5) {
    ctx.fillStyle = withAlpha('#e6f1f7', 0.22 + heat * 0.3);
    ctx.fillRect(x + r * 0.5, y + r * 0.1, Math.max(1, r * 0.22), Math.max(1, r * 0.22));
  }
}

/**
 * A short-lived quote bubble.
 *
 * `bubble.text` is already sanitized and truncated by the model. It is painted as plain
 * text; nothing here parses it, and no URL inside it is ever resolved or followed.
 */
function drawBubble(
  ctx: CanvasRenderingContext2D,
  bubble: AgentBubble,
  x: number,
  y: number,
  body: number,
  fieldX: number,
  fieldW: number,
): void {
  // Ease in fast, hold, fade out. Never a hard pop-out.
  const fade = bubble.age < 0.12 ? bubble.age / 0.12 : bubble.age > 0.7 ? (1 - bubble.age) / 0.3 : 1;
  const alpha = Math.max(0, Math.min(1, fade));
  if (alpha <= 0.01) return;

  ctx.font = '10px ui-monospace, monospace';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const padX = 6;
  const textW = ctx.measureText(bubble.text).width;
  const w = textW + padX * 2;
  const h = 17;
  // Rise as it ages, and keep the whole bubble inside the field rather than clipping it.
  const cy = y - body * 3.2 - 8 - bubble.age * 6;
  const cx = Math.max(fieldX + 2, Math.min(fieldX + fieldW - w - 2, x - w / 2));

  ctx.fillStyle = withAlpha('#070c14', 0.9 * alpha);
  roundRect(ctx, cx, cy - h / 2, w, h, 5);
  ctx.fill();
  ctx.strokeStyle = withAlpha('#35e6ff', 0.3 * alpha);
  ctx.lineWidth = 1;
  roundRect(ctx, cx + 0.5, cy - h / 2 + 0.5, w - 1, h - 1, 5);
  ctx.stroke();

  // Tail, pointing back at the speaking agent.
  const tailX = Math.max(cx + 5, Math.min(cx + w - 5, x));
  ctx.fillStyle = withAlpha('#070c14', 0.9 * alpha);
  ctx.beginPath();
  ctx.moveTo(tailX - 3.5, cy + h / 2 - 0.5);
  ctx.lineTo(tailX + 3.5, cy + h / 2 - 0.5);
  ctx.lineTo(tailX, cy + h / 2 + 4.5);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = withAlpha('#cfe6f2', 0.92 * alpha);
  ctx.fillText(bubble.text, cx + padX, cy);
}

/** Agent inspection card. Every value is text; nothing here is ever markup. */
function AgentCard({ hover, wrap }: { hover: Hover; wrap: HTMLDivElement | null }) {
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
      <h4>Observed agent</h4>
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
