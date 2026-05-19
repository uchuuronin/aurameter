/**
 * sparkline — lightweight svg line chart.
 * no dependencies. renders a 7-or-14-day trend for one signal.
 */

import type { trendPoint } from '../../core/dashboard/types.js';

interface Props {
  points: trendPoint[];
  color: string;
  height?: number;
  width?: number;
  mode?: 'count' | 'meanScore';
}

export function Sparkline({ points, color, height = 40, width = 120, mode = 'count' }: Props) {
  if (points.length < 2) {
    return (
      <svg width={width} height={height}>
        <text x={4} y={height / 2 + 4} fontSize={10} fill="var(--fg-muted)">no data</text>
      </svg>
    );
  }

  const values = points.map((p) => (mode === 'count' ? p.count : p.meanScore));
  const max = Math.max(...values, 1);
  const range = max || 1;
  const pad = 4;
  const w = width - pad * 2;
  const h = height - pad * 2;

  const toX = (i: number) => pad + (i / (points.length - 1)) * w;
  const toY = (v: number) => pad + h - (v / range) * h;

  const pathD = points
    .map((p, i) => {
      const v = mode === 'count' ? p.count : p.meanScore;
      return `${i === 0 ? 'M' : 'L'} ${toX(i).toFixed(1)} ${toY(v).toFixed(1)}`;
    })
    .join(' ');

  const areaD =
    pathD +
    ` L ${toX(points.length - 1).toFixed(1)} ${(pad + h).toFixed(1)}` +
    ` L ${pad} ${(pad + h).toFixed(1)} Z`;

  const gradId = `grad-${color.replace('#', '')}`;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block' }}>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.3} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={areaD} fill={`url(#${gradId})`} />
      <path d={pathD} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
