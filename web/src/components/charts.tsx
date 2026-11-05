/* 纯手写 SVG 图表，无第三方依赖、无 emoji */

export function DistributionChart({ data }: { data: { label: string; count: number }[] }) {
  const W = 600;
  const H = 220;
  const pad = { top: 18, right: 12, bottom: 34, left: 34 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;
  const max = Math.max(1, ...data.map((d) => d.count));
  const step = innerW / Math.max(1, data.length);
  const barW = Math.min(64, step * 0.56);

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="分数段分布">
      {[0, 0.5, 1].map((t) => {
        const y = pad.top + innerH * (1 - t);
        return (
          <g key={t}>
            <line className="grid" x1={pad.left} x2={W - pad.right} y1={y} y2={y} />
            <text x={pad.left - 8} y={y + 3.5} textAnchor="end">
              {Math.round(max * t)}
            </text>
          </g>
        );
      })}
      {data.map((d, i) => {
        const h = (d.count / max) * innerH;
        const x = pad.left + step * i + (step - barW) / 2;
        const y = pad.top + innerH - h;
        return (
          <g key={d.label}>
            <rect className="bar" x={x} y={y} width={barW} height={Math.max(h, d.count > 0 ? 3 : 0)} rx={4} />
            {d.count > 0 && (
              <text className="val" x={x + barW / 2} y={y - 6} textAnchor="middle">
                {d.count}
              </text>
            )}
            <text x={x + barW / 2} y={H - 12} textAnchor="middle">
              {d.label}
            </text>
          </g>
        );
      })}
      <line className="axis" x1={pad.left} x2={W - pad.right} y1={pad.top + innerH} y2={pad.top + innerH} />
    </svg>
  );
}

export function RateChart({ items }: { items: { no: string; rate: number }[] }) {
  const rowH = 30;
  const W = 600;
  const H = Math.max(80, items.length * rowH + 24);
  const left = 58;
  const right = 58;
  const innerW = W - left - right;
  const barH = 12;

  const color = (r: number) => (r >= 80 ? '#0f7b4f' : r >= 60 ? '#2f6fed' : '#c0392b');

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="各题得分率">
      {[0, 25, 50, 75, 100].map((t) => {
        const x = left + (innerW * t) / 100;
        return (
          <g key={t}>
            <line className="grid" x1={x} x2={x} y1={10} y2={H - 14} />
            <text x={x} y={H - 2} textAnchor="middle">
              {t}%
            </text>
          </g>
        );
      })}
      {items.map((it, i) => {
        const y = 16 + i * rowH;
        const w = Math.max(0, Math.min(100, it.rate)) / 100 * innerW;
        return (
          <g key={it.no + i}>
            <text x={left - 10} y={y + barH - 1} textAnchor="end">
              第{it.no}题
            </text>
            <rect x={left} y={y} width={innerW} height={barH} rx={3} fill="#f0f2f5" />
            <rect x={left} y={y} width={w} height={barH} rx={3} fill={color(it.rate)} />
            <text className="val" x={left + innerW + 8} y={y + barH - 1}>
              {it.rate.toFixed(0)}%
            </text>
          </g>
        );
      })}
      <line className="axis" x1={left} x2={left} y1={10} y2={H - 14} />
    </svg>
  );
}
