"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

/**
 * Report charts. Kept in a client component because Recharts renders on the
 * canvas-less SVG layer in the browser; the server passes plain arrays in.
 */

export type ChartDatum = { label: string; score: number; weight?: number };

function barColor(score: number): string {
  if (score >= 80) return "#34d399";
  if (score >= 65) return "#60a5fa";
  if (score >= 50) return "#fbbf24";
  return "#f87171";
}

export default function ReportCharts({
  title,
  data,
  height = 240,
}: {
  title: string;
  data: ChartDatum[];
  height?: number;
}) {
  const rows = data.map((datum) => ({ ...datum, score: Math.round(datum.score * 10) / 10 }));

  return (
    <div className="card">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">{title}</h2>
      <div style={{ width: "100%", height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 24, top: 4, bottom: 4 }}>
            <CartesianGrid horizontal={false} stroke="#2b3d34" />
            <XAxis type="number" domain={[0, 100]} tick={{ fill: "#93a89c", fontSize: 11 }} />
            <YAxis
              type="category"
              dataKey="label"
              width={130}
              tick={{ fill: "#93a89c", fontSize: 11 }}
            />
            <Tooltip
              contentStyle={{
                background: "#15211c",
                border: "1px solid #2b3d34",
                borderRadius: 8,
                color: "#f2f5f2",
                fontSize: 12,
              }}
              formatter={(value: number) => [`${value} / 100`, "Score"]}
            />
            <Bar dataKey="score" radius={[0, 4, 4, 0]} barSize={16}>
              {rows.map((row) => (
                <Cell key={row.label} fill={barColor(row.score)} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
