import React, { useState } from "react";
import type { ProviderView, ViewModel } from "../state.js";
import { ageDuration } from "../state.js";
import { displayName, isKnownProvider } from "../names.js";
import { failureWords } from "../components/ProviderDrawer.js";

export interface Readiness {
  status: "Ready" | "Sign in first";
  detail: string;
}

/**
 * Provider readiness from server state only. The browser cannot probe local
 * paths, so this reports what the daemon reported — never a local scan.
 */
export function readiness(provider: ProviderView): Readiness {
  const name = displayName(provider.id);
  if (provider.exclusionReason === null && provider.quota) {
    const age = ageDuration(provider.ageMs);
    return { status: "Ready", detail: age ? `Last read ${age} ago.` : "Reporting." };
  }
  if (provider.lastAttempt?.success && provider.lastAttempt.succeededAt) {
    return { status: "Ready", detail: "Connected — no readings yet." };
  }
  const credentialNote = "QuotaCap never handles those credentials.";
  if (!isKnownProvider(provider.id)) {
    return {
      status: "Sign in first",
      detail: `Add readings for ${name} with manual ingest, then re-poll. ${credentialNote}`,
    };
  }
  if (provider.lastAttempt?.failureCategory === "auth") {
    return {
      status: "Sign in first",
      detail: `Sign in to the ${name} CLI, then re-poll. ${credentialNote}`,
    };
  }
  if (!provider.lastAttempt) {
    return {
      status: "Sign in first",
      detail: `Install the ${name} CLI and sign in, then run the first poll. ${credentialNote}`,
    };
  }
  const failure = failureWords(provider.lastAttempt.failureCategory) ?? "Last attempt failed";
  return {
    status: "Sign in first",
    detail: `${failure} — check the ${name} CLI, then re-poll. ${credentialNote}`,
  };
}

function ProviderReadinessList({ providers }: { providers: ProviderView[] }) {
  return (
    <ul style={{ listStyle: "none", padding: 0 }}>
      {providers.map((p) => {
        const r = readiness(p);
        return (
          <li key={p.id} style={{ borderBottom: "1px solid var(--line)", padding: "8px 0" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <strong style={{ flexGrow: 1 }}>{displayName(p.id)}</strong>
              <span style={{ font: "var(--t-2)" }}>{r.status}</span>
            </div>
            <div style={{ font: "var(--t-2)" }}>{r.detail}</div>
          </li>
        );
      })}
    </ul>
  );
}

function SamplePreview() {
  return (
    <div
      aria-label="Sample payoff preview"
      style={{ border: "1px dashed var(--line-strong)", borderRadius: 8, padding: 12 }}
    >
      <p style={{ font: "var(--t-1)", marginTop: 0 }}>Sample data</p>
      <p style={{ font: "var(--t-3)" }}>Switch to Kimi next — 67% waste in 1.2d</p>
      <div style={{ height: 8, background: "var(--track)", borderRadius: 4, overflow: "hidden" }}>
        <div style={{ width: "22%", height: "100%", background: "var(--warn)" }} />
      </div>
      <p style={{ font: "var(--t-2)", marginBottom: 0 }}>Kimi · 22% used · Behind pace</p>
    </div>
  );
}

export function Onboarding({
  snapshot,
  onFirstPoll,
  polling,
  pollError,
}: {
  snapshot: ViewModel;
  onFirstPoll: () => void;
  polling: boolean;
  pollError: string | null;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  return (
    <div data-testid="setup-root" style={{ maxWidth: 640, margin: "0 auto", padding: 16 }}>
      <h1>Set up QuotaCap</h1>
      <p style={{ font: "var(--t-2)" }}>Step {step} of 3</p>

      {step === 1 && (
        <section data-testid="setup-step-1" aria-label="Step 1: Detect">
          <h2>What the daemon can see</h2>
          <p style={{ font: "var(--t-3)" }}>
            QuotaCap asked the running daemon what it knows. The dashboard cannot scan this machine
            from the browser, so anything missing here needs the provider CLI installed and signed
            in first.
          </p>
          <ProviderReadinessList providers={snapshot.providers} />
          <button type="button" onClick={() => setStep(2)}>
            Continue to review
          </button>
        </section>
      )}

      {step === 2 && (
        <section data-testid="setup-step-2" aria-label="Step 2: Review">
          <h2>Review accounts</h2>
          <p style={{ font: "var(--t-3)" }}>
            QuotaCap reads usage through your own provider CLIs. It never asks for, stores, or
            transmits your provider credentials — sign-in happens in the provider CLI itself, not
            here.
          </p>
          <ProviderReadinessList providers={snapshot.providers} />
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={() => setStep(1)}>
              Back
            </button>
            <button type="button" onClick={() => setStep(3)}>
              Continue to first poll
            </button>
          </div>
        </section>
      )}

      {step === 3 && (
        <section data-testid="setup-step-3" aria-label="Step 3: Start">
          <h2>Take the first readings</h2>
          <p style={{ font: "var(--t-3)" }}>
            Run the first poll. The daemon will ask each provider CLI for current usage and the
            dashboard will open when readings land.
          </p>
          <SamplePreview />
          <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
            <button type="button" onClick={() => setStep(2)}>
              Back
            </button>
            <button
              data-testid="setup-poll-button"
              type="button"
              onClick={onFirstPoll}
              disabled={polling}
            >
              {polling ? "Polling…" : "Run first poll"}
            </button>
          </div>
          {pollError && (
            <div data-testid="setup-poll-error" role="alert" style={{ marginTop: 8 }}>
              {pollError} <button type="button" onClick={onFirstPoll}>Retry</button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
