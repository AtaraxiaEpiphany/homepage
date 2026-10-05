/**
 * Hand-rolled Prometheus text-format registry: counters, gauges and one
 * fixed-bucket histogram style. The surface is tiny and stable, so no
 * prom-client dependency — swap it in only if this grows beyond a screen.
 */

type Labels = Record<string, string>;

type MetricType = "counter" | "gauge" | "histogram";

interface Meta {
  type: MetricType;
  help: string;
}

interface Histogram {
  buckets: readonly number[];
  /** bucket upper bound -> cumulative count */
  counts: number[];
  sum: number;
  count: number;
}

const meta = new Map<string, Meta>();
const series = new Map<string, number>(); // counters & gauges, keyed "name{labels}"
const histograms = new Map<string, Histogram>();

const escapeLabel = (v: string): string =>
  v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

const labelKey = (labels: Labels | undefined): string => {
  if (!labels || Object.keys(labels).length === 0) return "";
  const inner = Object.entries(labels)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
    .join(",");
  return `{${inner}}`;
};

const fullKey = (name: string, labels?: Labels): string => `${name}${labelKey(labels)}`;

function declare(name: string, type: MetricType, help: string): void {
  if (meta.has(name) && meta.get(name)!.type !== type) {
    throw new Error(`metric ${name} re-declared as ${type}`);
  }
  meta.set(name, { type, help });
}

export function incCounter(name: string, labels?: Labels, delta = 1): void {
  declare(name, "counter", COUNTER_HELP[name] ?? name);
  const key = fullKey(name, labels);
  series.set(key, (series.get(key) ?? 0) + delta);
}

export function setGauge(name: string, value: number, labels?: Labels): void {
  declare(name, "gauge", GAUGE_HELP[name] ?? name);
  series.set(fullKey(name, labels), value);
}

/** Observe a latency-style value in milliseconds into a fixed-bucket histogram. */
export function observeHistogram(name: string, help: string, buckets: readonly number[], ms: number): void {
  declare(name, "histogram", help);
  let h = histograms.get(name);
  if (!h || h.buckets !== buckets) {
    h = { buckets, counts: new Array(buckets.length).fill(0), sum: 0, count: 0 };
    histograms.set(name, h);
  }
  for (let i = 0; i < h.buckets.length; i++) {
    if (ms <= h.buckets[i]) h.counts[i]!++;
  }
  h.sum += ms;
  h.count += 1;
}

/** Render the registry in Prometheus text exposition format (v0.0.4). */
export function render(): string {
  const lines: string[] = [];
  for (const [name, { type, help }] of meta) {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
    if (type === "histogram") {
      const h = histograms.get(name);
      if (h) {
        h.buckets.forEach((le, i) => lines.push(`${name}_bucket{le="${le}"} ${h.counts[i]}`));
        lines.push(`${name}_bucket{le="+Inf"} ${h.count}`);
        lines.push(`${name}_sum ${h.sum}`);
        lines.push(`${name}_count ${h.count}`);
      }
      continue;
    }
    for (const [key, value] of series) {
      if (key === name || key.startsWith(`${name}{`)) lines.push(`${key} ${value}`);
    }
  }
  return lines.join("\n") + "\n";
}

/** Declared help strings, kept next to the emit sites that use them. */
const COUNTER_HELP: Record<string, string> = {
  ws_connections_total: "WebSocket connections accepted on /ws",
  session_creates_total: "Sessions successfully created",
  attach_ok_total: "Successful attach attempts",
  attach_fail_total: "Rejected attach attempts (gone or wrong secret)",
  rejections_total: "Create/attach requests rejected, by code",
  auth_failures_total: "Failed first-frame auth attempts",
  session_kills_total: "Sessions force-killed (reaper, drain, dispose)",
  session_exits_total: "Sessions whose shell process exited",
  queue_grants_total: "Waiting-room tickets granted, by kind (local/remote host)",
  redis_errors_total: "Redis operations failed, by op (broker mode)",
  admit_requests_total: "Broker preflight admissions attempted",
};

const GAUGE_HELP: Record<string, string> = {
  sessions_active: "Live shell sessions",
  queue_depth: "Waiting-room depth (local store: exact; redis store: ≤1s stale)",
};

export const SPAWN_BUCKETS_MS = [50, 100, 200, 400, 800, 1600, 3200] as const;
