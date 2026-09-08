import { useEffect, useRef } from "react";
import * as echarts from "echarts";

export default function TimeMachineChart({ timeline }) {
  const chartRef = useRef(null);
  const instanceRef = useRef(null);

  useEffect(() => {
    if (!chartRef.current || !timeline?.length) return;
    if (!instanceRef.current) {
      instanceRef.current = echarts.init(chartRef.current, "dark");
    }
    const chart = instanceRef.current;
    const years = timeline.map((t) => String(t.year));
    const green = timeline.map((t) => t.green_cover);
    const infra = timeline.map((t) => t.infrastructure_proxy);

    chart.setOption({
      backgroundColor: "transparent",
      tooltip: { trigger: "axis" },
      legend: { data: ["Green cover", "Infrastructure"], textStyle: { color: "#aaa" } },
      grid: { left: 48, right: 24, top: 48, bottom: 32 },
      xAxis: { type: "category", data: years },
      yAxis: { type: "value", splitLine: { lineStyle: { color: "#222" } } },
      series: [
        { name: "Green cover", type: "bar", data: green, itemStyle: { color: "#4ade80" } },
        { name: "Infrastructure", type: "line", data: infra, smooth: true, itemStyle: { color: "#00d4ff" } },
      ],
    });

    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [timeline]);

  useEffect(() => () => instanceRef.current?.dispose(), []);

  return <div ref={chartRef} style={{ width: "100%", height: 280 }} />;
}
