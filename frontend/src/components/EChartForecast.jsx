import { useEffect, useRef, useState } from "react";
import * as echarts from "echarts";

// ── Helpers ────────────────────────────────────────────

function fmtPop(v) {
  if (v == null) return "—";
  if (v >= 1e7) return `${(v / 1e7).toFixed(2)}\u00A0Cr`;
  if (v >= 1e5) return `${(v / 1e5).toFixed(2)}\u00A0L`;
  return Number(v).toLocaleString("en-US");
}

function fmtUnit(v, unit) {
  if (v == null) return "—";
  const u = (unit || "").toLowerCase();
  if (u.includes("people") || u.includes("population")) return fmtPop(v);
  if (u.includes("aqi")) return `${v} AQI`;
  if (u.includes("°c")) return `${v} °C`;
  if (u.includes("radiance") || u.includes("light")) return `${Number(v).toFixed(3)} nW`;
  if (u.includes("0-100") || u.includes("stress")) return `${v}/100`;
  return `${v}`;
}

function getTestSize(n) {
  return Math.min(5, Math.max(1, Math.floor(n * 0.2)));
}

// ── Actual vs Predicted chart (for expanding-window validation) ────────────

function ActualVsPredictedChart({ rows, color }) {
  const ref = useRef(null);
  const inst = useRef(null);

  useEffect(() => {
    if (!ref.current || !rows?.length) return;
    if (inst.current) { inst.current.dispose(); inst.current = null; }
    inst.current = echarts.init(ref.current, "dark");
    const chart = inst.current;

    const years = rows.map(r => String(r.test_year));
    const actuals = rows.map(r => r.actual);
    const preds = rows.map(r => r.predicted);
    const errors = rows.map(r => r.abs_error);

    chart.setOption({
      backgroundColor: "transparent",
      animation: true,
      animationDuration: 900,
      tooltip: {
        trigger: "axis",
        formatter: (params) => {
          const i = params[0].dataIndex;
          const r = rows[i];
          return `<div style="font-size:12px">
            <b>${r.test_year}</b><br/>
            <span style="color:#10b981">● Actual: ${fmtPop(r.actual)}</span><br/>
            <span style="color:${color}">● Predicted: ${fmtPop(r.predicted)}</span><br/>
            <span style="color:#f87171">Error: ${fmtPop(r.abs_error)} (${r.pct_error?.toFixed(1) ?? "—"}%)</span>
          </div>`;
        },
      },
      legend: {
        data: ["Actual", "Predicted", "Error"],
        textStyle: { color: "#aaa", fontSize: 10 },
        top: 4,
      },
      grid: { left: 60, right: 20, top: 40, bottom: 40 },
      xAxis: {
        type: "category", data: years,
        axisLine: { lineStyle: { color: "#444" } },
        axisLabel: { color: "#888", fontSize: 10 },
      },
      yAxis: [
        {
          type: "value",
          name: "Population",
          nameTextStyle: { color: "#666", fontSize: 10 },
          splitLine: { lineStyle: { color: "#1a1a2e" } },
          axisLabel: { color: "#888", fontSize: 10, formatter: v => fmtPop(v) },
        },
        {
          type: "value",
          name: "Error",
          nameTextStyle: { color: "#666", fontSize: 10 },
          axisLabel: { color: "#888", fontSize: 10, formatter: v => fmtPop(v) },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: "Actual",
          type: "line",
          data: actuals,
          yAxisIndex: 0,
          smooth: true,
          lineStyle: { width: 3, color: "#10b981" },
          itemStyle: { color: "#10b981" },
          symbol: "circle", symbolSize: 7,
        },
        {
          name: "Predicted",
          type: "line",
          data: preds,
          yAxisIndex: 0,
          smooth: true,
          lineStyle: { width: 3, color, type: "dashed" },
          itemStyle: { color },
          symbol: "diamond", symbolSize: 7,
        },
        {
          name: "Error",
          type: "bar",
          data: errors,
          yAxisIndex: 1,
          itemStyle: { color: "rgba(248,113,113,0.4)", borderRadius: [3, 3, 0, 0] },
          barMaxWidth: 20,
        },
      ],
    });

    const t1 = setTimeout(() => chart.resize(), 120);
    const t2 = setTimeout(() => chart.resize(), 400);
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => { clearTimeout(t1); clearTimeout(t2); window.removeEventListener("resize", onResize); };
  }, [rows, color]);

  useEffect(() => () => inst.current?.dispose(), []);

  return <div ref={ref} style={{ width: "100%", height: 220 }} />;
}

// ── Main forecast chart (train/test split + forecast) ────────────────────

function ForecastLineChart({ metric, color, unit }) {
  const ref = useRef(null);
  const inst = useRef(null);

  useEffect(() => {
    if (!ref.current) return;
    if (inst.current) { inst.current.dispose(); inst.current = null; }
    inst.current = echarts.init(ref.current, "dark");
    const chart = inst.current;

    const hist = metric?.historical || [];
    const fc = metric?.forecast_5yr || [];
    const testSize = getTestSize(hist.length);
    const trainEnd = hist.length - testSize;

    const years = [];
    const trainData = [];
    const testData = [];
    const forecastData = [];

    hist.forEach((h, i) => {
      years.push(String(h.year));
      trainData.push(i <= trainEnd ? h.value : null);
      testData.push(i >= trainEnd ? h.value : null);
      forecastData.push(null);
    });

    if (hist.length > 0 && fc.length > 0) {
      const lastVal = hist[hist.length - 1].value;
      forecastData[forecastData.length - 1] = lastVal;
    }

    fc.forEach(f => {
      years.push(String(f.year));
      trainData.push(null);
      testData.push(null);
      forecastData.push(f.value);
    });

    chart.setOption({
      backgroundColor: "transparent",
      animation: true,
      animationDuration: 900,
      tooltip: {
        trigger: "axis",
        formatter: (params) => {
          const yr = params[0]?.axisValue;
          const lines = params.filter(p => p.value != null)
            .map(p => `<span style="color:${p.color}">●</span> ${p.seriesName}: <b>${fmtUnit(p.value, unit)}</b>`);
          return `<div style="font-size:12px"><b>${yr}</b><br/>${lines.join("<br/>")}</div>`;
        },
      },
      legend: {
        data: ["Training", "Testing (held-out)", "Forecast"],
        textStyle: { color: "#aaa", fontSize: 10 }, top: 4,
      },
      grid: { left: 60, right: 20, top: 40, bottom: 36 },
      xAxis: {
        type: "category", data: years,
        axisLine: { lineStyle: { color: "#444" } },
        axisLabel: { color: "#888", fontSize: 10 },
      },
      yAxis: {
        type: "value",
        splitLine: { lineStyle: { color: "#1a1a2e" } },
        axisLabel: { color: "#888", fontSize: 10, formatter: v => fmtUnit(v, unit) },
      },
      series: [
        {
          name: "Training",
          type: "line",
          data: trainData,
          smooth: true,
          lineStyle: { width: 3, color: "#10b981" },
          itemStyle: { color: "#10b981" },
          symbol: "circle", symbolSize: 5,
        },
        {
          name: "Testing (held-out)",
          type: "line",
          data: testData,
          smooth: true,
          lineStyle: { width: 3, color: "#f59e0b", type: "dotted" },
          itemStyle: { color: "#f59e0b" },
          symbol: "circle", symbolSize: 6,
        },
        {
          name: "Forecast",
          type: "line",
          data: forecastData,
          smooth: true,
          lineStyle: { width: 3, color, type: "dashed" },
          itemStyle: { color },
          symbol: "circle", symbolSize: 5,
        },
      ],
    });

    const t1 = setTimeout(() => chart.resize(), 100);
    const t2 = setTimeout(() => chart.resize(), 400);
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => { clearTimeout(t1); clearTimeout(t2); window.removeEventListener("resize", onResize); };
  }, [metric, color, unit]);

  useEffect(() => () => inst.current?.dispose(), []);

  return <div ref={ref} style={{ width: "100%", height: 240 }} />;
}

// ── Population-specific full panel (exact Section 1c layout) ───────────

function PopulationPanel({ metric, color = "#3b82f6", locationName }) {
  const hist = metric?.historical || [];
  const model = metric?.model || {};
  const validation = model?.validation || {};
  const rows = validation.validation_rows || [];
  const forecastList = metric?.forecast_5yr || [];

  const finalYear = model.final_forecast_year || forecastList[0]?.year || 2026;
  const finalVal = model.final_forecast_value != null ? model.final_forecast_value : forecastList[0]?.value;

  const testSize = getTestSize(hist.length);
  const trainCount = hist.length - testSize;

  return (
    <div className="pop-panel">
      {/* 1. Location & Source */}
      <div className="pop-source-header">
        <div className="pop-loc-title">📍 Location: <span>{locationName || "Selected Location"}</span></div>
        <div className="pop-source-indicator">
          Source: <strong>{metric?.source || "WorldPop (District boundary)"}</strong>
          {metric?.level ? ` · ${metric.level}` : ""}
        </div>
      </div>

      {/* 2. Historical Table */}
      <div className="pop-section-title">📋 Historical Population</div>
      {hist.length > 0 ? (
        <div className="pop-table-scroll">
          <table className="pop-table hist-table">
            <thead>
              <tr>
                <th style={{ minWidth: 70 }}>Year</th>
                <th style={{ minWidth: 120 }}>Population</th>
                <th style={{ minWidth: 100 }}>Type</th>
              </tr>
            </thead>
            <tbody>
              {hist.map((h) => (
                <tr key={h.year}>
                  <td className="cell-year"><b>{h.year}</b></td>
                  <td className="cell-num"><strong>{fmtPop(h.value)}</strong></td>
                  <td className="cell-center">
                    <span className={`pop-type-badge ${h.type === "historical" ? "official" : "estimated"}`}>
                      {h.type === "historical" ? "Official" : "Estimated"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="pop-validation-note">Verified historical population data is unavailable for this location.</div>
      )}

      {/* 3. Forecast Chart */}
      <div className="pop-section-title" style={{ marginTop: 18 }}>📈 Forecast Chart (2015 – 2030)</div>
      <div className="split-legend">
        <span className="split-dot" style={{ background: "#10b981" }} />
        <span className="split-lbl">Training ({trainCount} yrs)</span>
        <span className="split-dot" style={{ background: "#f59e0b" }} />
        <span className="split-lbl">Testing ({testSize} yrs held-out)</span>
        <span className="split-dot" style={{ background: color }} />
        <span className="split-lbl">Forecast (ARIMA)</span>
      </div>
      <ForecastLineChart metric={metric} color={color} unit="people" />

      {/* 4. ARIMA Big Stat Callout (prominent card) */}
      <div className="arima-big-stat-card">
        <div className="arima-big-stat-heading">🤖 ARIMA — Predicted Population {finalYear}</div>
        <div className="arima-big-stat-number">{fmtPop(finalVal)}</div>
        <div className="arima-big-stat-subtitle">Based on chronological expanding-window validated ARIMA model</div>
      </div>

      {/* 5. Validation Table */}
      {rows.length > 0 && (
        <>
          <div className="pop-section-title" style={{ marginTop: 18 }}>🔍 Chronological Expanding-Window Validation</div>
          <div className="pop-table-scroll">
            <table className="pop-table validation-table">
              <thead>
                <tr>
                  <th style={{ minWidth: 110 }}>Training Period</th>
                  <th style={{ minWidth: 80 }}>Test Year</th>
                  <th style={{ minWidth: 90 }}>Actual</th>
                  <th style={{ minWidth: 90 }}>Predicted</th>
                  <th style={{ minWidth: 90 }}>Abs Error</th>
                  <th style={{ minWidth: 90 }}>MAE</th>
                  <th style={{ minWidth: 90 }}>RMSE</th>
                  <th style={{ minWidth: 80 }}>MAPE</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.test_year}>
                    <td className="cell-period">{r.train_start}–{r.train_end}</td>
                    <td className="cell-year"><b>{r.test_year}</b></td>
                    <td className="cell-num">{fmtPop(r.actual)}</td>
                    <td className="cell-num">{fmtPop(r.predicted)}</td>
                    <td className="cell-num cell-error">{fmtPop(r.abs_error)}</td>
                    <td className="cell-num">{r.mae != null ? fmtPop(r.mae) : "—"}</td>
                    <td className="cell-num">{r.rmse != null ? fmtPop(r.rmse) : "—"}</td>
                    <td className="cell-num cell-mape">{r.mape != null ? `${r.mape}%` : "—"}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="validation-summary-row">
                  <th><span className="summary-tag">OVERALL</span></th>
                  <th><span className="summary-subtag">{rows.length} test{rows.length > 1 ? "s" : ""}</span></th>
                  <th className="cell-dash">—</th>
                  <th className="cell-dash">—</th>
                  <th className="cell-dash">—</th>
                  <th>
                    <div className="summary-metric-chip mae">
                      <small>MAE</small>
                      <span>{validation.mae != null ? fmtPop(validation.mae) : "—"}</span>
                    </div>
                  </th>
                  <th>
                    <div className="summary-metric-chip rmse">
                      <small>RMSE</small>
                      <span>{validation.rmse != null ? fmtPop(validation.rmse) : "—"}</span>
                    </div>
                  </th>
                  <th>
                    <div className="summary-metric-chip mape">
                      <small>MAPE</small>
                      <span>{validation.mape != null ? `${validation.mape}%` : "—"}</span>
                    </div>
                  </th>
                </tr>
              </tfoot>
            </table>
          </div>
          <div className="population-method-note">
            Chronological expanding-window validation: each model trains only on earlier years and forecasts 1 held-out year. No random split.
          </div>

          {/* 6. 3 Metric Boxes side-by-side */}
          <div className="population-metrics-grid">
            <div className="pop-metric-card">
              <span>MAE</span>
              <strong>{validation.mae != null ? fmtPop(validation.mae) : "—"}</strong>
              <small>Mean Absolute Error</small>
            </div>
            <div className="pop-metric-card">
              <span>RMSE</span>
              <strong>{validation.rmse != null ? fmtPop(validation.rmse) : "—"}</strong>
              <small>Root Mean Square Error</small>
            </div>
            <div className="pop-metric-card">
              <span>MAPE</span>
              <strong>{validation.mape != null ? `${validation.mape}%` : "—"}</strong>
              <small>Mean Absolute % Error</small>
            </div>
          </div>

          {/* 7. Actual vs Predicted Chart */}
          <div className="pop-section-title" style={{ marginTop: 18 }}>📊 Actual vs Predicted across Test Years</div>
          <ActualVsPredictedChart rows={rows} color={color} />
        </>
      )}
    </div>
  );
}

// ── Generic forecast panel (AQI, Weather, Migration) ────────────────────

function GenericForecastPanel({ title, metric, color, unit }) {
  const hist = metric?.historical || [];
  const testSize = getTestSize(hist.length);
  const trainCount = hist.length - testSize;
  const model = metric?.model || {};
  const rmse = model.rmse;
  const mae = model.mae;
  const mape = model.mape;

  return (
    <div className="chart-card">
      <div className="chart-card-title">{title}</div>

      <div className="split-legend">
        <span className="split-dot" style={{ background: "#10b981" }} />
        <span className="split-lbl">Training ({trainCount} pts)</span>
        <span className="split-dot" style={{ background: "#f59e0b" }} />
        <span className="split-lbl">Testing ({testSize} pts, held-out)</span>
        <span className="split-dot" style={{ background: color }} />
        <span className="split-lbl">Forecast</span>
      </div>

      <ForecastLineChart metric={metric} color={color} unit={unit} />

      {model.method && (
        <div className="generic-model-metrics">
          <div className="generic-model-row">
            <span className="generic-model-label">Model Architecture:</span>
            <span className="generic-model-val">{model.method}</span>
          </div>
          <div className="generic-metrics-boxes">
            {mae != null && (
              <div className="generic-metric-box">
                <span className="metric-box-label">MAE</span>
                <strong className="metric-box-val">{fmtUnit(mae, unit)}</strong>
                <small className="metric-box-desc">Mean Absolute Error</small>
              </div>
            )}
            {rmse != null && (
              <div className="generic-metric-box">
                <span className="metric-box-label">RMSE</span>
                <strong className="metric-box-val">{fmtUnit(rmse, unit)}</strong>
                <small className="metric-box-desc">Root Mean Square Error</small>
              </div>
            )}
            {mape != null && (
              <div className="generic-metric-box">
                <span className="metric-box-label">MAPE</span>
                <strong className="metric-box-val">{mape}%</strong>
                <small className="metric-box-desc">Mean Absolute % Error</small>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main export ──────────────────────────────────────────────────────────

export default function EChartForecast({ title, metric, color, unit, layerKey, locationName }) {
  if (layerKey === "population") {
    return (
      <div className="chart-card">
        <PopulationPanel metric={metric} color={color} locationName={locationName} />
      </div>
    );
  }
  return <GenericForecastPanel title={title} metric={metric} color={color} unit={unit} />;
}
