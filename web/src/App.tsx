import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { fetchQuotas, fetchRecommendation } from "./api.js";

interface Quota {
  provider: string;
  usedPct: number;
  resetsAt: string;
  periodStart?: string;
  plan?: string;
  fetchedAt?: string;
  stale?: boolean;
  ageMs?: number;
}

interface Rec {
  use: string;
  reason: string;
  wastePct?: number;
  idealRate?: number;
  advisories?: Array<{
    provider: string;
    daysLeft: number;
    idealRate: number;
    burnRate: number;
    burnMeasured: boolean;
    status: string;
    wastePct: number;
    urgency: string;
  }>;
  alternatives?: Quota[];
}

function formatReset(resetsAt: string): string {
  const diff = new Date(resetsAt).getTime() - Date.now();
  const h = Math.round(diff / 3600000);
  if (h < 24) return `${h}h`;
  const days = (h / 24).toFixed(1);
  return `${days}d`;
}

function Banner({ rec }: { rec: Rec | null }) {
  if (!rec) return <div data-testid="banner">loading…</div>;
  if (rec.use && rec.reason) {
    return (
      <div data-testid="banner" style={{ background: "#fef08a", padding: 12, borderRadius: 8, marginBottom: 12 }}>
        ⚡ Use <strong>{rec.use}</strong> next — {rec.reason}
      </div>
    );
  }
  return <div data-testid="banner">On track — lowest waste is {rec.use}</div>;
}

function App() {
  const [quotas, setQuotas] = useState<Quota[]>([]);
  const [rec, setRec] = useState<Rec | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [lastPollAt, setLastPollAt] = useState<string | null>(null);

  useEffect(() => {
    fetchQuotas()
      .then(setQuotas)
      .catch((e) => setFetchError(String(e?.message ?? e)));
    fetchRecommendation()
      .then(setRec)
      .catch(() => {});
    fetch("/health")
      .then((r) => r.json())
      .then((j) => j?.lastPollAt && setLastPollAt(j.lastPollAt))
      .catch(() => {});
  }, []);

  const sorted = [...quotas].sort(
    (a, b) => new Date(a.resetsAt).getTime() - new Date(b.resetsAt).getTime()
  );

  const advisoriesByProvider = new Map<string, NonNullable<Rec["advisories"]>[number]>();
  for (const a of rec?.advisories ?? []) advisoriesByProvider.set(a.provider, a);

  const hasStale = sorted.some((q) => q.stale ?? (q.fetchedAt ? Date.now() - new Date(q.fetchedAt).getTime() > 60 * 60 * 1000 : false));
  const isDegraded = !!fetchError || (quotas.length === 0 && !rec);

  return (
    <div style={{ fontFamily: "system-ui", padding: 16, maxWidth: 900, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, margin: "0 0 12px" }}>QuotaCap</h1>
      <Banner rec={rec} />
      {isDegraded && (
        <div data-testid="error-banner" style={{ background: "#fecaca", padding: 10, borderRadius: 8, marginBottom: 12, fontSize: 13 }}>
          no fresh data{lastPollAt ? `, last ${new Date(lastPollAt).toLocaleString()}` : ""} — check network/daemon{fetchError ? `: ${fetchError}` : ""}
        </div>
      )}
      {hasStale && (
        <div data-testid="stale-banner" style={{ background: "#ffedd5", padding: 8, borderRadius: 8, marginBottom: 12, fontSize: 12 }}>
          some quotas stale — <button onClick={() => fetch("/api/refresh", { method: "POST" }).then(() => location.reload())} style={{ border: "1px solid #d1d5db", background: "#fff", borderRadius: 4, padding: "2px 6px", cursor: "pointer" }}>Refresh now</button>
        </div>
      )}

      <div data-testid="strip" style={{ display: "flex", gap: 8, margin: "12px 0", overflowX: "auto", alignItems: "center" }}>
        <span style={{ color: "#2563eb", fontWeight: 700 }}>NOW</span>
        {sorted.map((q) => (
          <span
            key={q.provider}
            style={{ border: "1px solid #d1d5db", borderRadius: 999, padding: "4px 10px", whiteSpace: "nowrap", background: "#fff" }}
          >
            {q.provider} {formatReset(q.resetsAt)}
          </span>
        ))}
        {sorted.length === 0 && <span style={{ color: "#9ca3af" }}>no quotas yet</span>}
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "2px solid #e5e7eb" }}>
            <th style={{ padding: "8px 6px" }}>Provider</th>
            <th style={{ padding: "8px 6px" }}>Quota</th>
            <th style={{ padding: "8px 6px" }}>Remaining</th>
            <th style={{ padding: "8px 6px" }}>Resets</th>
            <th style={{ padding: "8px 6px" }}>Days left</th>
            <th style={{ padding: "8px 6px" }}>Ideal</th>
            <th style={{ padding: "8px 6px" }}>Rate</th>
            <th style={{ padding: "8px 6px" }}>Status</th>
            <th style={{ padding: "8px 6px" }}>Waste</th>
            <th style={{ padding: "8px 6px" }}>Advice</th>
            <th style={{ padding: "8px 6px" }}></th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((q) => {
            const adv = advisoriesByProvider.get(q.provider);
            const waste = adv?.wastePct ?? 0;
            const ideal = adv?.idealRate;
            const burn = adv?.burnRate;
            const burnMeasured = adv?.burnMeasured;
            const urgency = adv?.urgency ?? "";
            const status = adv?.status ?? "on track";
            const isExpanded = expanded === q.provider;
            const isStale = q.stale ?? (q.fetchedAt ? Date.now() - new Date(q.fetchedAt).getTime() > 60 * 60 * 1000 : false);
            return (
              <React.Fragment key={q.provider}>
                <tr style={{ background: waste > 30 ? "#fff7ed" : isStale ? "#fffbeb" : undefined, borderBottom: "1px solid #f3f4f6" }}>
                  <td style={{ padding: "8px 6px", fontWeight: 600 }}>
                    {q.provider} {isStale && <span style={{ background: "#f59e0b", color: "#fff", fontSize: 10, padding: "2px 4px", borderRadius: 4, marginLeft: 6 }}>stale</span>}
                  </td>
                  <td style={{ padding: "8px 6px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{ width: 80, height: 8, background: "#e5e7eb", borderRadius: 4, overflow: "hidden" }}>
                        <div
                          style={{
                            width: `${Math.min(100, q.usedPct)}%`,
                            height: "100%",
                            background: waste > 30 ? "#f59e0b" : "#3b82f6",
                          }}
                        />
                      </div>
                      <span>{q.usedPct}%</span>
                    </div>
                  </td>
                  <td style={{ padding: "8px 6px" }}>{100 - q.usedPct}%</td>
                  <td style={{ padding: "8px 6px" }}>{formatReset(q.resetsAt)}</td>
                  <td style={{ padding: "8px 6px" }}>{adv?.daysLeft != null ? adv.daysLeft.toFixed(1) : "—"}</td>
                  <td style={{ padding: "8px 6px" }}>{ideal != null ? `${ideal.toFixed(1)}%/d` : "—"}</td>
                  <td style={{ padding: "8px 6px" }}>{burn != null ? (burnMeasured ? `${burn.toFixed(1)}%/d` : "collecting…") : "—"}</td>
                  <td style={{ padding: "8px 6px" }}>{status === "at risk" ? "⚠️ at risk" : "✅ on track"}</td>
                  <td style={{ padding: "8px 6px" }}>{adv?.wastePct != null ? `${Math.round(adv.wastePct)}%` : "—"}</td>
                  <td style={{ padding: "8px 6px" }}>{urgency || "—"}</td>
                  <td style={{ padding: "8px 6px" }}>
                    <button
                      aria-label={`expand ${q.provider}`}
                      onClick={() => setExpanded(isExpanded ? null : q.provider)}
                      style={{ cursor: "pointer", border: "1px solid #d1d5db", background: "#fff", borderRadius: 4, padding: "2px 6px" }}
                    >
                      {isExpanded ? "▼" : "▶"}
                    </button>
                  </td>
                </tr>
                {isExpanded && (
                  <tr>
                    <td colSpan={6} style={{ padding: 0 }}>
                      <div style={{ padding: 12, background: "#f9fafb", borderTop: "1px solid #e5e7eb" }}>
                        <div style={{ position: "relative", height: 24, background: "#e5e7eb", borderRadius: 4, overflow: "hidden", marginBottom: 8 }}>
                          <div
                            style={{
                              position: "absolute",
                              left: "10%",
                              top: 0,
                              bottom: 0,
                              width: 2,
                              background: "#2563eb",
                            }}
                            title="NOW"
                          />
                          <div style={{ position: "absolute", left: 0, right: 0, top: 11, height: 2, background: "#22c55e" }} />
                          <div
                            style={{
                              position: "absolute",
                              left: `${Math.min(90, Math.max(10, 10 + q.usedPct * 0.8))}%`,
                              top: 4,
                              width: 8,
                              height: 8,
                              borderRadius: "50%",
                              background: "#f59e0b",
                            }}
                          />
                        </div>
                        <div style={{ fontSize: 12, color: "#6b7280" }}>
                          → {Math.round(waste)}% waste if idle · resets {new Date(q.resetsAt).toLocaleString()} · ideal {ideal?.toFixed(1) ?? "—"}%/d
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={6} style={{ padding: 24, textAlign: "center", color: "#9ca3af" }}>
                no data — run poll or ingest
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <footer style={{ marginTop: 16, fontSize: 12, color: "#6b7280", display: "flex", gap: 8, alignItems: "center" }}>
        <span>last refresh {lastPollAt ? new Date(lastPollAt).toLocaleTimeString() : new Date().toLocaleTimeString()}</span>
        <button onClick={() => location.reload()} style={{ border: "1px solid #d1d5db", background: "#fff", borderRadius: 4, padding: "4px 8px", cursor: "pointer" }}>
          Refresh
        </button>
      </footer>
    </div>
  );
}

const el = document.getElementById("app");
if (el) createRoot(el).render(<App />);

export default App;
