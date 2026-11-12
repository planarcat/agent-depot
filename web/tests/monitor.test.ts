import { describe, expect, test } from "bun:test";
import {
  diffSamples,
  eventRateSeries,
  formatDelta,
  formatRss,
  formatUptime,
  type HealthSample,
  pushSample,
  sampleFromHealth,
  sparklinePoints,
} from "../src/core/monitor.ts";

const health = {
  ok: true,
  rev: 10,
  events: 20,
  rss_kb: 2048,
  fds: 12,
  subs: 1,
  watched: 28,
  failed_watches: 0,
  degraded: false,
  uptime_s: 90,
};

function sample(over: Partial<HealthSample> = {}): HealthSample {
  return { ...sampleFromHealth(health, 1000), ...over };
}

describe("health sample", () => {
  test("字段映射与默认值", () => {
    const s = sampleFromHealth(health, 123);
    expect(s.at).toBe(123);
    expect(s.rev).toBe(10);
    expect(s.events).toBe(20);
    expect(s.rssKb).toBe(2048);
    expect(s.watched).toBe(28);
    expect(s.uptimeS).toBe(90);
    expect(s.degraded).toBe(false);
  });

  test("缺失/非法值归零", () => {
    const s = sampleFromHealth({} as never);
    expect(s.rev).toBe(0);
    expect(s.rssKb).toBe(0);
    expect(s.degraded).toBe(false);
  });

  test("首帧无 delta，后续返回差值", () => {
    expect(diffSamples(null, sample())).toBeNull();
    const d = diffSamples(sample(), sample({ rev: 15, events: 30, rssKb: 1024, fds: 10, subs: 2 }));
    expect(d).toEqual({ rev: 5, events: 10, rssKb: -1024, fds: -2, subs: 1 });
  });

  test("历史窗口截断到 max", () => {
    let h: HealthSample[] = [];
    for (let i = 0; i < 65; i += 1) h = pushSample(h, sample({ rev: i }), 60);
    expect(h).toHaveLength(60);
    expect(h[0]?.rev).toBe(5);
    expect(h[59]?.rev).toBe(64);
  });

  test("事件速率序列忽略负增长并跳过首帧", () => {
    const h = [sample({ events: 10 }), sample({ events: 13 }), sample({ events: 12 })];
    expect(eventRateSeries(h)).toEqual([3, 0]);
    expect(eventRateSeries([])).toEqual([]);
  });
});

describe("sparkline", () => {
  test("空/单点不出线", () => {
    expect(sparklinePoints([])).toBe("");
    expect(sparklinePoints([5])).toBe("");
  });

  test("平坦序列落在中线", () => {
    const pts = sparklinePoints([7, 7, 7], 100, 32);
    expect(pts).toBe("0.0,16.0 50.0,16.0 100.0,16.0");
  });

  test("递增序列从左下到右上", () => {
    const pts = sparklinePoints([1, 2, 3], 100, 32);
    const parts = pts.split(" ");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("0.0,31.0");
    expect(parts[2]).toBe("100.0,1.0");
  });
});

describe("format", () => {
  test("uptime", () => {
    expect(formatUptime(0)).toBe("0s");
    expect(formatUptime(45)).toBe("45s");
    expect(formatUptime(125)).toBe("2m 5s");
    expect(formatUptime(3725)).toBe("1h 2m 5s");
    expect(formatUptime(90_061)).toBe("1d 1h 1m");
  });

  test("rss", () => {
    expect(formatRss(512)).toBe("512 KB");
    expect(formatRss(2048)).toBe("2.0 MB");
  });

  test("delta", () => {
    expect(formatDelta(null)).toBe("—");
    expect(formatDelta(0)).toBe("0");
    expect(formatDelta(3)).toBe("+3");
    expect(formatDelta(-2)).toBe("-2");
  });
});
