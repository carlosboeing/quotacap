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
    <form onSubmit={(e) => void submit(e)}>
      <h4>Manual ingest</h4>
      <p style={{ font: "var(--t-2)" }}>
        Paste usage text for a provider without an adapter. The server validates it; nothing is parsed here.
      </p>
      <div>
        <label>
          Provider{" "}
          <input
            type="text"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            placeholder="my-plan"
            aria-label="Provider id for manual ingest"
          />
        </label>
      </div>
      <div>
        <label>
          Usage text{" "}
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label="Usage text for manual ingest"
            rows={3}
          />
        </label>
      </div>
      {error && (
        <div data-testid="ingest-error" role="alert">
          {error}
        </div>
      )}
      {saved && (
        <div data-testid="ingest-saved" role="status">
          {saved}
        </div>
      )}
      <button type="submit" disabled={!ready || sending}>
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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3 style={{ font: "var(--t-4)", margin: 0 }}>Providers</h3>
        <button type="button" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? "Polling…" : "Re-poll now"}
        </button>
      </div>
      <ul style={{ listStyle: "none", padding: 0 }}>
        {providers.map((p) => {
          const age = ageDuration(p.ageMs);
          const failed = p.lastAttempt && !p.lastAttempt.success ? failureWords(p.lastAttempt.failureCategory) : null;
          return (
            <li key={p.id} style={{ borderBottom: "1px solid var(--line)", padding: "8px 0" }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <strong style={{ flexGrow: 1 }}>{displayName(p.id)}</strong>
                <span style={{ font: "var(--t-2)" }}>{providerStatus(p)}</span>
                <label style={{ font: "var(--t-2)" }} title="Provider toggles are managed in the config file">
                  <input type="checkbox" checked={p.enabled} disabled={true} aria-label={`Enable ${displayName(p.id)}`} />{" "}
                  Enabled
                </label>
              </div>
              <div style={{ font: "var(--t-2)" }}>
                {age ? `Last read ${age} ago` : "Last read unknown"}
                {failed ? ` · ${failed}` : ""}
              </div>
            </li>
          );
        })}
      </ul>
      <p style={{ font: "var(--t-2)" }}>
        Enable or disable providers in <code>~/.quotacap/config.json</code> (<code>enabledProviders</code>),
        then restart the daemon. Toggles here are read-only until the server offers a settings API.
      </p>
      <IngestForm onIngested={onIngested} />
    </div>
  );
}
