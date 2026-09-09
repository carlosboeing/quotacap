import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  daemonEndpoint,
  loadState,
  triggerRefresh,
  StateHttpError,
  StateNetworkError,
} from "./api.js";
import { ageLabel, firstRun, toViewModel, type ViewModel } from "./state.js";

type ShellError =
  | { kind: "service-unavailable"; message: string }
  | { kind: "http-error"; status: number; message: string };

function UnavailablePanel({
  endpoint,
  lastGood,
  onRetry,
}: {
  endpoint: string;
  lastGood: ViewModel | null;
  onRetry: () => void;
}) {
  return (
    <div data-testid="state-unavailable" role="alert">
      <h2>Service unavailable</h2>
      <p>
        The QuotaCap daemon did not answer at <code>{endpoint}</code>. Start it with{" "}
        <code>quotacap daemon</code>, then retry.
      </p>
      <button type="button" onClick={onRetry}>
        Retry
      </button>
      {lastGood && <p>Showing last readings ({ageLabel(lastGood.asOf)}).</p>}
    </div>
  );
}

function HttpErrorPanel({
  status,
  message,
  lastGood,
  onRetry,
}: {
  status: number;
  message: string;
  lastGood: ViewModel | null;
  onRetry: () => void;
}) {
  return (
    <div data-testid="state-http-error" role="alert">
      <h2>Request failed (HTTP {status})</h2>
      <p>{message}</p>
      <button type="button" onClick={onRetry}>
        Retry
      </button>
      {lastGood && <p>Showing last readings ({ageLabel(lastGood.asOf)}).</p>}
    </div>
  );
}

/** Interim ready view. Tasks 3–5 replace these blocks with real components. */
function ReadyView({ snapshot }: { snapshot: ViewModel }) {
  if (firstRun(snapshot)) {
    return (
      <div data-testid="dashboard-root">
        <h1>QuotaCap</h1>
        <p data-testid="rec-prose">No quotas yet. Complete setup to take your first readings.</p>
      </div>
    );
  }
  return (
    <div data-testid="dashboard-root">
      <h1>QuotaCap</h1>
      <p data-testid="rec-prose">
        Switch to {snapshot.recommendation.use} next — {snapshot.recommendation.reason}
      </p>
      <ul>
        {snapshot.providers.map((p) => (
          <li key={p.id}>
            {p.id}
            {p.exclusionReason ? ` (${p.exclusionReason})` : ""}
          </li>
        ))}
      </ul>
      <p>
        {snapshot.providers.length} tracked · {ageLabel(snapshot.asOf)}
      </p>
    </div>
  );
}

function App() {
  const [snapshot, setSnapshot] = useState<ViewModel | null>(null);
  const [error, setError] = useState<ShellError | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSnapshot(toViewModel(await loadState()));
      setError(null);
    } catch (e) {
      if (e instanceof StateNetworkError) {
        setError({ kind: "service-unavailable", message: e.message });
      } else if (e instanceof StateHttpError) {
        setError({ kind: "http-error", status: e.status, message: e.message });
      } else {
        setError({ kind: "http-error", status: 0, message: String(e) });
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setNotice(null);
    try {
      const result = await triggerRefresh();
      if (result.message) setNotice(result.message);
      await load();
    } catch (e) {
      if (e instanceof StateNetworkError) {
        setError({ kind: "service-unavailable", message: e.message });
      } else if (e instanceof StateHttpError) {
        setError({ kind: "http-error", status: e.status, message: e.message });
      } else {
        setError({ kind: "http-error", status: 0, message: String(e) });
      }
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  return (
    <div>
      <button data-testid="refresh-button" type="button" onClick={() => void refresh()} disabled={refreshing}>
        {refreshing ? "Refreshing…" : "Refresh"}
      </button>
      {notice && (
        <div data-testid="refresh-notice" role="status">
          {notice}
        </div>
      )}
      {loading && !snapshot && (
        <div data-testid="state-loading" aria-busy="true">
          Loading quota state…
        </div>
      )}
      {error?.kind === "service-unavailable" && !snapshot && (
        <UnavailablePanel endpoint={daemonEndpoint()} lastGood={snapshot} onRetry={() => void load()} />
      )}
      {error?.kind === "http-error" && !snapshot && (
        <HttpErrorPanel
          status={error.status}
          message={error.message}
          lastGood={snapshot}
          onRetry={() => void load()}
        />
      )}
      {error && snapshot && (
        <div data-testid="state-stale-error" role="alert">
          {error.kind === "http-error" ? `Request failed (HTTP ${error.status}): ` : "Service unavailable: "}
          {error.message} Showing last readings ({ageLabel(snapshot.asOf)}).{" "}
          <button type="button" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      {snapshot && <ReadyView snapshot={snapshot} />}
    </div>
  );
}

const el = document.getElementById("app");
if (el) createRoot(el).render(<App />);

export default App;
