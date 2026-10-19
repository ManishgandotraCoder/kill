import type { MiniCandle } from "@/lib/predict";

/** Small candlestick chart as inline SVG. */
export default function MiniCandles({
  candles,
  highlightLast = false,
  ghost,
  className = "mb-1 h-16 w-full",
}: {
  className?: string;
  candles: MiniCandle[];
  highlightLast?: boolean;
  ghost?: { base: number; close: number; low: number; high: number };
}) {
  const slots = candles.length + (ghost ? 1 : 0);
  const W = slots * 10;
  const H = 64;
  let lo = Math.min(...candles.map((c) => c[3]));
  let hi = Math.max(...candles.map((c) => c[2]));
  if (ghost) {
    lo = Math.min(lo, ghost.low);
    hi = Math.max(hi, ghost.high);
  }
  const pad = (hi - lo) * 0.06 || 1;
  lo -= pad;
  hi += pad;
  const y = (v: number) => H - ((v - lo) / (hi - lo)) * H;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={className} preserveAspectRatio="none" role="img" aria-label="candlestick pattern">
      {highlightLast && <rect x={(candles.length - 1) * 10} y={0} width={10} height={H} className="fill-zinc-200 dark:fill-zinc-800" />}
      {candles.map(([, o, h, l, c], i) => {
        const x = i * 10 + 5;
        const upC = c >= o;
        const cls = upC ? "fill-[#0ca30c] stroke-[#0ca30c]" : "fill-[#d03b3b] stroke-[#d03b3b]";
        return (
          <g key={i} className={cls}>
            <line x1={x} x2={x} y1={y(h)} y2={y(l)} strokeWidth={1} vectorEffect="non-scaling-stroke" />
            <rect x={x - 3} y={Math.min(y(o), y(c))} width={6} height={Math.max(1, Math.abs(y(o) - y(c)))} strokeWidth={0} />
          </g>
        );
      })}
      {ghost && (
        <g className="fill-none stroke-[#2a78d6] dark:stroke-[#3987e5]">
          <line
            x1={candles.length * 10 + 5}
            x2={candles.length * 10 + 5}
            y1={y(ghost.high)}
            y2={y(ghost.low)}
            strokeWidth={1}
            strokeDasharray="2 2"
            vectorEffect="non-scaling-stroke"
          />
          <rect
            x={candles.length * 10 + 2}
            y={Math.min(y(ghost.base), y(ghost.close))}
            width={6}
            height={Math.max(1.5, Math.abs(y(ghost.base) - y(ghost.close)))}
            strokeWidth={1}
            strokeDasharray="2 1"
            vectorEffect="non-scaling-stroke"
          />
        </g>
      )}
    </svg>
  );
}
