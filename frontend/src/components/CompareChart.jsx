import React from "react";

const METRICS = [
  {
    key: "population",
    label: "Population",
    icon: "👥",
    desc: "WorldPop Gridded Demographics",
    format: (v) => {
      if (v == null) return "—";
      if (v >= 1e7) return `${(v / 1e7).toFixed(2)} Cr`;
      if (v >= 1e5) return `${(v / 1e5).toFixed(2)} L`;
      return Number(v).toLocaleString();
    },
    compareText: (a, b, nameA, nameB) => {
      if (!a || !b) return null;
      if (a === b) return "Equal population scale";
      const diffPct = Math.abs(((b - a) / (a || 1)) * 100).toFixed(0);
      return b > a
        ? `${nameB} is +${diffPct}% larger`
        : `${nameA} is +${diffPct}% larger`;
    },
    favorsLower: false,
  },
  {
    key: "aqi",
    label: "Air Quality (AQI)",
    icon: "🌫️",
    desc: "OpenAQ Real-Time Telemetry",
    format: (v) => {
      if (v == null) return "—";
      const num = Math.round(Number(v));
      const status =
        num <= 50 ? "Good" : num <= 100 ? "Moderate" : num <= 150 ? "Sensitive" : num <= 200 ? "Unhealthy" : "Hazardous";
      return `${num} AQI (${status})`;
    },
    compareText: (a, b, nameA, nameB) => {
      if (!a || !b) return null;
      if (Math.round(a) === Math.round(b)) return "Identical air quality";
      const diff = Math.abs(Math.round(a - b));
      return a < b
        ? `${nameA} is ${diff} AQI cleaner`
        : `${nameB} is ${diff} AQI cleaner`;
    },
    favorsLower: true,
  },
  {
    key: "weather",
    label: "Average Temperature",
    icon: "🌡️",
    desc: "Open-Meteo Surface Temperature",
    format: (v) => (v != null ? `${Number(v).toFixed(1)}°C` : "—"),
    compareText: (a, b, nameA, nameB) => {
      if (a == null || b == null) return null;
      const diff = Math.abs(a - b).toFixed(1);
      if (Number(diff) === 0) return "Identical temperature";
      return a < b ? `${nameA} is ${diff}°C cooler` : `${nameB} is ${diff}°C cooler`;
    },
    favorsLower: null,
  },
  {
    key: "urban_growth",
    label: "Nighttime Light Radiance",
    icon: "✨",
    desc: "VIIRS Settlement Expansion Proxy",
    format: (v) => (v != null ? `${Number(v).toFixed(2)} nW/cm²` : "—"),
    compareText: (a, b, nameA, nameB) => {
      if (!a || !b) return null;
      const ratio = (b / Math.max(a, 0.05)).toFixed(1);
      return b > a
        ? `${nameB} has ${ratio}x higher radiance`
        : `${nameA} has ${(a / Math.max(b, 0.05)).toFixed(1)}x higher radiance`;
    },
    favorsLower: false,
  },
  {
    key: "urban_stress",
    label: "Urban Stress Index",
    icon: "⚡",
    desc: "Infrastructure & Density Pressure",
    format: (v) => (v != null ? `${Number(v).toFixed(1)} / 100` : "Low"),
    compareText: (a, b, nameA, nameB) => {
      if (a == null || b == null) return null;
      const diff = Math.abs(a - b).toFixed(1);
      return a < b
        ? `${nameA} has lower stress (-${diff})`
        : `${nameB} has lower stress (-${diff})`;
    },
    favorsLower: true,
  },
];

export default function CompareChart({ data, nameA, nameB }) {
  if (!data?.comparison) return null;
  const comp = data.comparison;
  const locA = data.location_a;
  const locB = data.location_b;

  const cleanNameA = nameA?.split(",")[0] || locA?.name?.split(",")[0] || "Benchmark City";
  const cleanNameB = nameB?.split(",")[0] || locB?.name?.split(",")[0] || "Target City";

  return (
    <div className="compare-redesign-wrapper">
      {/* ── Top Dual City Hero Cards ──────────────────────────────────── */}
      <div className="compare-hero-grid">
        <div className="compare-city-box city-a">
          <div className="city-role-badge">BENCHMARK LOCATION</div>
          <h3 className="city-headline">{cleanNameA}</h3>
          {locA?.lat != null && (
            <div className="city-coord-text">{locA.lat.toFixed(3)}°N, {locA.lon.toFixed(3)}°E</div>
          )}
        </div>

        <div className="compare-vs-badge">VS</div>

        <div className="compare-city-box city-b">
          <div className="city-role-badge">COMPARISON TARGET</div>
          <h3 className="city-headline">{cleanNameB}</h3>
          {locB?.lat != null && (
            <div className="city-coord-text">{locB.lat.toFixed(3)}°N, {locB.lon.toFixed(3)}°E</div>
          )}
        </div>
      </div>

      {/* ── Key Comparative Differences Callout Banner ──────────────── */}
      <div className="compare-differences-banner">
        <div className="diff-banner-header">
          <span className="diff-icon">🎯</span>
          <strong>KEY COMPARATIVE DIFFERENCES & STRATEGIC ADVANTAGES</strong>
        </div>
        <div className="diff-chips-row">
          {METRICS.map((m) => {
            const a = comp[m.key]?.a;
            const b = comp[m.key]?.b;
            const diffTxt = m.compareText(a, b, cleanNameA, cleanNameB);
            if (!diffTxt) return null;
            return (
              <div key={m.key} className="diff-insight-pill">
                <span className="pill-metric-icon">{m.icon}</span>
                <span className="pill-metric-text">{diffTxt}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Organized Head-to-Head Comparative Metric Matrix ───────── */}
      <div className="compare-matrix-section">
        <div className="matrix-section-title">
          <span>📊 HEAD-TO-HEAD METRIC COMPARISON MATRIX</span>
        </div>

        <div className="compare-rows-container">
          {METRICS.map((m) => {
            const valA = comp[m.key]?.a;
            const valB = comp[m.key]?.b;
            const numA = Number(valA) || 0;
            const numB = Number(valB) || 0;
            const total = Math.max(numA + numB, 0.001);
            const pctA = Math.round((numA / total) * 100);
            const pctB = 100 - pctA;

            const diffTxt = m.compareText(valA, valB, cleanNameA, cleanNameB);

            return (
              <div key={m.key} className="compare-metric-card">
                {/* Metric Header Row */}
                <div className="metric-card-top">
                  <div className="metric-info-col">
                    <span className="m-icon">{m.icon}</span>
                    <div>
                      <strong className="m-name">{m.label}</strong>
                      <small className="m-sub">{m.desc}</small>
                    </div>
                  </div>
                  {diffTxt && <span className="m-diff-badge">{diffTxt}</span>}
                </div>

                {/* Values & Progress Split Bar */}
                <div className="metric-split-row">
                  <div className="metric-val-block val-a">
                    <span className="val-loc-name">{cleanNameA}</span>
                    <strong className="val-number">{m.format(valA)}</strong>
                  </div>

                  <div className="metric-bar-wrapper">
                    <div className="dual-progress-track">
                      <div
                        className="progress-fill-a"
                        style={{ width: `${Math.max(8, Math.min(92, pctA))}%` }}
                        title={`${cleanNameA}: ${pctA}% ratio`}
                      />
                      <div
                        className="progress-fill-b"
                        style={{ width: `${Math.max(8, Math.min(92, pctB))}%` }}
                        title={`${cleanNameB}: ${pctB}% ratio`}
                      />
                    </div>
                    <div className="bar-sub-ratio">
                      <span>{pctA}%</span>
                      <span>VS</span>
                      <span>{pctB}%</span>
                    </div>
                  </div>

                  <div className="metric-val-block val-b">
                    <span className="val-loc-name">{cleanNameB}</span>
                    <strong className="val-number">{m.format(valB)}</strong>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── AI Comparative Synthesis ─────────────────────────────────── */}
      {data?.ai_summary && (
        <div className="compare-ai-dossier">
          <div className="ai-dossier-header">
            <span className="ai-sparkle">🤖</span>
            <strong>GEOSPATIAL AI COMPARATIVE SYNTHESIS</strong>
          </div>
          <p className="ai-dossier-text">{data.ai_summary}</p>
        </div>
      )}
    </div>
  );
}
