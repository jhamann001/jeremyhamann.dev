import type { TwrGrowthPoint } from "@/lib/twr/engine";
import { usd } from "@/lib/twr/engine";

// Growth-of-$100k chart — inline SVG, no chart lib (ported from the approved
// report_engine.js chart()). `points` is the compounded daily-return index:
// [{Incep, 100000}, ...one per funded month]. Geometry is identical to the
// approved PDF (same viewBox, padding, gridlines, green line + end label).
export function GrowthChart({ points }: { points: TwrGrowthPoint[] }) {
  const w = 700;
  const h = 250;
  const padL = 54;
  const padR = 14;
  const padT = 14;
  const padB = 30;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const vals = points.map((p) => p.value);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const yMin = Math.floor((lo - 3000) / 5000) * 5000;
  const yMax = Math.ceil((hi + 3000) / 5000) * 5000;
  const X = (i: number) => padL + (i * plotW) / (points.length - 1);
  const Y = (v: number) => padT + ((yMax - v) / (yMax - yMin)) * plotH;

  const gridlines: number[] = [];
  for (let v = yMin; v <= yMax; v += (yMax - yMin) / 4) gridlines.push(v);

  const poly = points.map((p, i) => `${X(i).toFixed(1)},${Y(p.value).toFixed(1)}`).join(" ");
  const endVal = vals[vals.length - 1];

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      width="100%"
      xmlns="http://www.w3.org/2000/svg"
      fontFamily="Arial,sans-serif"
    >
      {gridlines.map((v, i) => {
        const y = Y(v);
        return (
          <g key={`g${i}`}>
            <line x1={padL} y1={y} x2={w - padR} y2={y} stroke="#eef0f2" />
            <text x={padL - 8} y={y + 3} fontSize="9" fill="#9ca3af" textAnchor="end">
              ${Math.round(v / 1000)}k
            </text>
          </g>
        );
      })}
      {points.map((p, i) =>
        i % 2 === 0 || i === points.length - 1 ? (
          <text
            key={`x${i}`}
            x={X(i)}
            y={h - 10}
            fontSize="8.5"
            fill="#9ca3af"
            textAnchor="middle"
          >
            {p.label}
          </text>
        ) : null,
      )}
      <polyline fill="none" stroke="#166534" strokeWidth="2.2" points={poly} />
      <text
        x={X(points.length - 1) - 4}
        y={Y(endVal) - 6}
        fontSize="10"
        fill="#166534"
        fontWeight="700"
        textAnchor="end"
      >
        {usd(endVal)}
      </text>
    </svg>
  );
}
