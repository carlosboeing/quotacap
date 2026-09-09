import React, { useState } from "react";
import type { ProviderView } from "../../state.js";
import { ageDuration } from "../../state.js";
import { displayName } from "../../names.js";
import { postIngest, StateHttpError, StateNetworkError } from "../../api.js";
import { failureWords } from "../ProviderDrawer.js";

export interface IngestPayload {
  provider: string;
  text: string;
}

/** Usage text goes to the server exactly as typed. No client-side parsing. */
export function ingestPayload(provider: string, text: string): IngestPayload {
  return { provider, text };
}

export type SettingsStatus = "Ready" | "Stale" | "Failed" | "Invalid" | "Reset passed" | "Not reporting";

/** Short status from server exclusion and attempt fields. */
export function providerStatus(provider: ProviderView): SettingsStatus {
  switch (provider.exclusionReason) {
    case "stale":
      return "Stale";
    case "provider-failed":
      return "Failed";
    case "invalid":
      return "Invalid";
    case "reset-passed":
      return "Reset passed";
    case "not-reporting":
      return "Not reporting";
    case null:
      return provider.lastAttempt && !provider.lastAttempt.success ? "Failed" : "Ready";
  }
}

function IngestForm({ onIngested }: { onIngested: () => void }) {
  const [provider, setProvider] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const ready = provider.trim().length > 0 && text.trim().length > 0;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || sending) return;
    setSending(true);
    setError(null);
    setSaved(null);
    try {
      const payload = ingestPayload(provider, text);
      const result = await postIngest(payload.provider, payload.text);
      setSaved(result.message ?? "Saved.");
      setText("");
      onIngested();
    } catch (err) {
      if (err instanceof StateHttpError) setError(`HTTP ${err.status}: ${err.message}`);
      else if (err instanceof StateNetworkError) setError(err.message);
      else setError(String(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <form
      onSubmit={(e) => void submit(e)}
      style={{
        display: "grid",
        gap: "var(--s3)",
        background: "var(--surface-raised)",
        padding: "var(--s4)",
        borderRadius: "var(--r-md)",
        border: "1px solid var(--line)",
      }}
    >
      <div>
        <h4 style={{ fontSize: "var(--t-3)", fontWeight: 700, margin: "0 0 var(--s1)" }}>Manual Quota Ingest</h4>
        <p style={{ fontSize: "var(--t-2)", color: "var(--ink-soft)", margin: 0 }}>
          Paste usage text for a provider without an adapter. The server validates it; nothing is parsed here.
        </p>
      </div>
      <div>
        <label style={{ fontSize: "var(--t-2)", fontWeight: 600, display: "block", marginBottom: 4 }}>
          Provider ID
        </label>
        <input
          type="text"
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          placeholder="e.g. copilot, cursor, my-plan"
          aria-label="Provider id for manual ingest"
          style={{
            width: "100%",
            boxSizing: "border-box",
            font: "inherit",
            fontSize: "var(--t-2)",
            padding: "8px 10px",
            borderRadius: "var(--r-sm)",
            border: "1px solid var(--line)",
            background: "var(--surface)",
            color: "var(--ink)",
          }}
        />
      </div>
      <div>
        <label style={{ fontSize: "var(--t-2)", fontWeight: 600, display: "block", marginBottom: 4 }}>
          Usage text
        </label>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Usage text for manual ingest"
          placeholder="e.g. 'Used 45 of 100 requests. Resets in 2 days.'"
          rows={3}
          style={{
            width: "100%",
            boxSizing: "border-box",
            font: "inherit",
            fontSize: "var(--t-2)",
            padding: "8px 10px",
            borderRadius: "var(--r-sm)",
            border: "1px solid var(--line)",
            background: "var(--surface)",
            color: "var(--ink)",
          }}
        />
      </div>
      {error && (
        <div data-testid="ingest-error" role="alert" className="alert" style={{ marginBottom: 0 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span>{error}</span>
        </div>
      )}
      {saved && (
        <div
          data-testid="ingest-saved"
          role="status"
          style={{
            padding: "8px 12px",
            background: "var(--good-soft)",
            border: "1px solid var(--good)",
            borderRadius: "var(--r-sm)",
            color: "var(--good)",
            fontSize: "var(--t-2)",
            fontWeight: 600,
          }}
        >
          {saved}
        </div>
      )}
      <button
        type="submit"
        className="btn btn-primary"
        style={{ justifySelf: "start", padding: "6px 14px" }}
        disabled={!ready || sending}
      >
        {sending ? "Sending…" : "Send to server"}
      </button>
    </form>
  );
}

export function ProvidersPanel({
  providers,
  onRefresh,
  refreshing,
  onIngested,
}: {
  providers: ProviderView[];
  onRefresh: () => void;
  refreshing: boolean;
  onIngested: () => void;
}) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--s3)" }}>
        <h3 style={{ fontSize: "var(--t-3)", fontWeight: 700, margin: 0 }}>Active Tool Connections</h3>
        <button
          type="button"
          className="btn btn-quiet btn-sm"
          onClick={onRefresh}
          disabled={refreshing}
          style={{ fontSize: "var(--t-1)", padding: "4px 8px" }}
        >
          {refreshing ? "Polling…" : "Re-poll adapters"}
        </button>
      </div>

      <div
        style={{
          border: "1px solid var(--line)",
          borderRadius: "var(--r-md)",
          overflow: "hidden",
          background: "var(--surface)",
          marginBottom: "var(--s3)",
        }}
      >
        {providers.map((p, i) => {
          const age = ageDuration(p.ageMs);
          const failed = p.lastAttempt && !p.lastAttempt.success ? failureWords(p.lastAttempt.failureCategory) : null;
          const status = providerStatus(p);
          const isReady = status === "Ready";
          return (
            <div
              key={p.id}
              style={{
                padding: "10px 14px",
                borderBottom: i < providers.length - 1 ? "1px solid var(--line)" : "none",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "var(--s3)",
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <b style={{ fontSize: "var(--t-3)", color: "var(--ink)" }}>{displayName(p.id)}</b>
                  <label
                    style={{ fontSize: "var(--t-1)", color: "var(--ink-faint)", display: "inline-flex", alignItems: "center", gap: 4 }}
                    title="Provider toggles are managed in the config file"
                  >
                    <input type="checkbox" checked={p.enabled} disabled={true} aria-label={`Enable ${displayName(p.id)}`} />
                    Enabled
                  </label>
                </div>
                <span style={{ display: "block", fontSize: "var(--t-1)", color: "var(--ink-soft)", marginTop: 2 }}>
                  {age ? `Last read ${age} ago` : "Last read unknown"}
                  {failed ? ` · ${failed}` : ""}
                </span>
              </div>
              <span
                className={isReady ? "st-ready" : "st-todo"}
                style={{
                  fontSize: "var(--t-1)",
                  padding: "2px 8px",
                  borderRadius: 999,
                  background: isReady ? "var(--good-soft)" : "var(--warn-soft)",
                  border: `1px solid ${isReady ? "var(--good)" : "var(--warn)"}`,
                  color: isReady ? "var(--good)" : "var(--warn)",
                  fontWeight: 600,
                  flex: "none",
                }}
              >
                {status}
              </span>
            </div>
          );
        })}
      </div>

      <p style={{ fontSize: "var(--t-1)", color: "var(--ink-soft)", margin: "0 0 var(--s5)" }}>
        Enable or disable providers in <code>~/.quotacap/config.json</code> (<code>enabledProviders</code>),
        then restart the daemon. Toggles here are read-only until the server offers a settings API.
      </p>

      <IngestForm onIngested={onIngested} />
    </div>
  );
}

