'use client';

/**
 * Messages-per-minute sparkline.
 *
 * Deliberately small: it exists to make spikes obvious at a glance, not to compete with
 * the swarm field. Drawn on a canvas so it costs nothing to update alongside the field.
 */

import { useEffect, useRef } from 'react';

export interface RateChartProps {
  /** `[bucketStart, ratePerMinute]`, oldest first. */
  series: Array<[number, number]>;
  /** Right edge of the window, matching the swarm field. */
  now: number;
  windowMs: number;
}

const HEIGHT = 34;

export default function RateChart({ series, now, windowMs }: RateChartProps) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth;
    if (w === 0) return;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(HEIGHT * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, HEIGHT);

    const t0 = now - windowMs;
    const visible = series.filter(([t]) => t >= t0 && t <= now);
    if (visible.length === 0) return;

    const peak = Math.max(...visible.map(([, v]) => v), 1);
    const xOf = (t: number) => ((t - t0) / windowMs) * w;
    const yOf = (v: number) => HEIGHT - 1 - (v / peak) * (HEIGHT - 3);

    // Filled area under the curve, so a spike reads as mass rather than a thin spike.
    ctx.beginPath();
    ctx.moveTo(xOf(visible[0][0]), HEIGHT);
    for (const [t, v] of visible) ctx.lineTo(xOf(t), yOf(v));
    ctx.lineTo(xOf(visible[visible.length - 1][0]), HEIGHT);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, HEIGHT);
    grad.addColorStop(0, 'rgba(53,230,255,0.34)');
    grad.addColorStop(1, 'rgba(53,230,255,0.02)');
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < visible.length; i++) {
      const [t, v] = visible[i];
      const x = xOf(t);
      const y = yOf(v);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#35e6ff';
    ctx.lineWidth = 1;
    ctx.stroke();
  }, [series, now, windowMs]);

  const peak = series.length > 0 ? Math.max(...series.map(([, v]) => v)) : 0;

  return (
    <div className="rate">
      <small>
        <span>Messages / min</span>
        <span>peak {Math.round(peak).toLocaleString()}</span>
      </small>
      <canvas ref={ref} style={{ width: '100%', height: HEIGHT }} aria-hidden="true" />
    </div>
  );
}
