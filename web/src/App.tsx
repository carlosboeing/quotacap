import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./theme.css";
import {
  daemonEndpoint,
  loadState,
  triggerRefresh,
  StateHttpError,
  StateNetworkError,
} from "./api.js";
import { ageLabel, firstRun, toViewModel, type ViewModel } from "./state.js";
import { Recommendation } from "./components/Recommendation.js";
import { SubscriptionList } from "./components/SubscriptionList.js";
import { ResetRail } from "./components/ResetRail.js";
import { ProviderDrawer } from "./components/ProviderDrawer.js";
import { SettingsDrawer } from "./components/settings/SettingsDrawer.js";
import { navigate, routeFor, useRoute } from "./router.js";
import { Onboarding } from "./pages/Onboarding.js";
import { Header } from "./components/Header.js";
import { FaultBanner } from "./components/FaultBanner.js";

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

/** Interim ready view. Task 9 replaces the placeholder header. */
function ReadyView({
  snapshot,
  onSelectProvider,
}: {
  snapshot: ViewModel;
  onSelectProvider: (id: string) => void;
}) {
  return (
    <div data-testid="dashboard-root">
      <Recommendation
        recommendation={snapshot.recommendation}
        providers={snapshot.providers}
        asOf={snapshot.asOf}
        onSelectProvider={onSelectProvider}
      />
      {!firstRun(snapshot) && (
        <>
          <ResetRail
            providers={snapshot.providers}
            asOf={snapshot.asOf}
            onSelectProvider={onSelectProvider}
          />
          <SubscriptionList
            providers={snapshot.providers}
            recommendation={snapshot.recommendation}
            asOf={snapshot.asOf}
            onSelectProvider={onSelectProvider}
          />
        </>
      )}
    </div>
  );
}

function App() {
  const [snapshot, setSnapshot] = useState<ViewModel | null>(null);
  const [error, setError] = useState<ShellError | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const route = useRoute();
  const target = snapshot ? routeFor(route, firstRun(snapshot)) : null;

  useEffect(() => {
    if (target && target !== route) navigate(target);
  }, [target, route]);

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

  const setupMode = target === "/setup";
  const pollErrorText = error
    ? error.kind === "http-error"
      ? `Request failed (HTTP ${error.status}): ${error.message}`
      : `Service unavailable: ${error.message}`
    : null;

  if (snapshot && setupMode) {
    return (
      <div>
        <Onboarding
          snapshot={snapshot}
          onFirstPoll={() => void refresh()}
          polling={refreshing}
          pollError={pollErrorText}
        />
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "0 16px" }}>
      <Header
        runtime={snapshot?.runtime ?? null}
        refreshing={refreshing}
        onRefresh={() => void refresh()}
        onSettings={() => setSettingsOpen(true)}
      />
      {notice && (
        <div data-testid="refresh-notice" role="status">
          {notice}
        </div>
      )}
      {loading && !snapshot && (
        <div data-testid="state-loading" aria-busy="true" aria-label="Loading quota state">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              aria-hidden="true"
              style={{
                height: 64,
                background: "var(--surface-raised)",
                border: i === 0 ? "1px solid var(--rec)" : "1px solid var(--line)",
                borderRadius: 8,
                marginBottom: 8,
              }}
            />
          ))}
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
      {snapshot && (
        <FaultBanner
          providers={snapshot.providers}
          onRepoll={() => void refresh()}
          repolling={refreshing}
        />
      )}
      {snapshot && (
        <ReadyView snapshot={snapshot} onSelectProvider={(id) => setSelectedProvider(id)} />
      )}
      <ProviderDrawer
        provider={snapshot?.providers.find((p) => p.id === selectedProvider) ?? null}
        onClose={() => setSelectedProvider(null)}
      />
      <SettingsDrawer
        open={settingsOpen}
        providers={snapshot?.providers ?? []}
        onRefresh={() => void refresh()}
        refreshing={refreshing}
        onIngested={() => void load()}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}

const el = document.getElementById("app");
if (el) createRoot(el).render(<App />);

export default App;
