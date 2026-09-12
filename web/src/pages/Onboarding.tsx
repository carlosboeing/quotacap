import React, { useState } from "react";
import type { ProviderView, ViewModel } from "../state.js";
import { ageDuration } from "../state.js";
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
  const name = provider.displayName;
  // agy:3p shares the agy adapter: there is no separate CLI to install.
  const cli = provider.id === "agy:3p" ? "Antigravity" : name;
  if (provider.exclusionReason === null && provider.quota) {
    const age = ageDuration(provider.ageMs);
    return { status: "Ready", detail: age ? `Last read ${age} ago.` : "Reporting." };
  }
  if (provider.lastAttempt?.success && provider.lastAttempt.succeededAt) {
    return { status: "Ready", detail: "Connected — no readings yet." };
  }
  const credentialNote = "QuotaCap never handles those credentials.";
  if (provider.harness === null) {
    return {
      status: "Sign in first",
      detail: `QuotaCap has no live adapter for ${name}. Use manual ingest via the CLI to add readings.`,
    };
  }
  if (provider.lastAttempt?.failureCategory === "auth") {
    return {
      status: "Sign in first",
      detail: `Sign in to the ${cli} CLI, then re-poll. ${credentialNote}`,
    };
  }
  if (!provider.lastAttempt) {
    return {
      status: "Sign in first",
      detail: `Install the ${cli} CLI and sign in, then run the first poll. ${credentialNote}`,
    };
  }
  const failure = failureWords(provider.lastAttempt.failureCategory) ?? "Last attempt failed";
  return {
    status: "Sign in first",
    detail: `${failure} — check the ${cli} CLI, then re-poll. ${credentialNote}`,
  };
}

function ProviderReadinessList({ providers }: { providers: ProviderView[] }) {
  return (
    <div className="provlist">
      {providers.map((p) => {
        const r = readiness(p);
        const isReady = r.status === "Ready";
        return (
          <div key={p.id} className="provrow">
            <b>{p.displayName}</b>
            <span className="path">{r.detail}</span>
            <span className={isReady ? "st-ready" : "st-todo"}>
              {isReady ? (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              ) : (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              )}
              {r.status}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function SamplePreview() {
  return (
    <div className="preview" aria-label="Sample payoff preview">
      <div
        className="preview-head"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "var(--s3)",
        }}
      >
        <span style={{ fontWeight: 600 }}>What your first result will show</span>
        <span
          className="chip-sample"
          style={{
            fontSize: "var(--t-1)",
            padding: "2px 8px",
            borderRadius: 999,
            background: "var(--surface-raised)",
            border: "1px solid var(--line-strong)",
            fontWeight: 600,
            color: "var(--ink-soft)",
          }}
        >
          Sample data
        </span>
      </div>
      <div className="trackwrap">
        <div
          className="tline"
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: "var(--t-2)",
            marginBottom: 4,
          }}
        >
          <span className="used" style={{ fontWeight: 600 }}>
            Kimi Code · 22% used
          </span>
          <span className="gap" style={{ color: "var(--ink-soft)" }}>
            61 points behind pace
          </span>
        </div>
        <div
          className="track"
          role="img"
          aria-label="Sample: 22 percent of quota used, 83 percent of the window elapsed"
        >
          <div
            className="fill"
            style={{
              width: "22%",
              background: "var(--fill-behind)",
              borderRight: "1px solid var(--edge-behind)",
            }}
          />
          <div className="mark" style={{ left: "83%" }} />
        </div>
        <div
          className="tfoot"
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: "var(--t-1)",
            color: "var(--ink-faint)",
            marginTop: 4,
          }}
        >
          <span>start</span>
          <span>time elapsed: 83%</span>
          <span>reset</span>
        </div>
      </div>
      <p style={{ fontSize: "var(--t-2)", color: "var(--ink-soft)", margin: "var(--s3) 0 0" }}>
        Switch to Kimi next — 67% waste in 1.2d
      </p>
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
    <div
      data-testid="setup-root"
      style={{
        maxWidth: 960,
        margin: "0 auto",
        padding: "var(--s5) var(--s4) 56px",
      }}
    >
      <p className="eyebrow" style={{ marginBottom: "var(--s1)" }}>First run &amp; accounts</p>
      <h1
        style={{
          fontSize: "var(--t-6)",
          letterSpacing: "-0.024em",
          margin: "0 0 var(--s5)",
          fontWeight: 700,
        }}
      >
        Connect the subscriptions you already use
      </h1>

      <div className="setup">
        <ol className="steps">
          <li className={step === 1 ? "is-now" : ""} aria-current={step === 1 ? "step" : undefined}>
            <span className="num">1</span>
            <span>
              <span className="t">Detect</span>
              <span className="d">Find installed coding tools</span>
            </span>
          </li>
          <li className={step === 2 ? "is-now" : ""} aria-current={step === 2 ? "step" : undefined}>
            <span className="num">2</span>
            <span>
              <span className="t">Review</span>
              <span className="d">Check what each adapter reads</span>
            </span>
          </li>
          <li className={step === 3 ? "is-now" : ""} aria-current={step === 3 ? "step" : undefined}>
            <span className="num">3</span>
            <span>
              <span className="t">Start</span>
              <span className="d">Read current usage once</span>
            </span>
          </li>
        </ol>

        <div className="panel">
          {step === 1 && (
            <section data-testid="setup-step-1" aria-label="Step 1: Detect">
              <div className="panel-head">
                <p className="eyebrow">Step 1 of 3</p>
                <h2>What the daemon can see</h2>
                <p>
                  QuotaCap asked the running daemon what it knows. The dashboard cannot scan this
                  machine from the browser, so anything missing here needs the provider CLI installed
                  and signed in first.
                </p>
                <div className="privacy">
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="var(--good)"
                    strokeWidth="2.2"
                    style={{ flex: "none" }}
                    aria-hidden="true"
                  >
                    <path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z" />
                    <path d="M9 12l2 2 4-4" />
                  </svg>
                  <div>
                    <b>Usage history stays on this machine</b>
                    <span>
                      QuotaCap reads quota percentages and reset times only. It never accesses code,
                      prompts, or sensitive files.
                    </span>
                  </div>
                </div>
              </div>
              <ProviderReadinessList providers={snapshot.providers} />
              <div className="panel-foot">
                <span style={{ fontSize: "var(--t-2)", color: "var(--ink-soft)" }}>
                  You can add, disable, or repair providers at any time.
                </span>
                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={() => setStep(2)}
                >
                  Continue to review
                </button>
              </div>
            </section>
          )}

          {step === 2 && (
            <section data-testid="setup-step-2" aria-label="Step 2: Review">
              <div className="panel-head">
                <p className="eyebrow">Step 2 of 3</p>
                <h2>Review accounts</h2>
                <p>
                  QuotaCap reads usage through your own provider CLIs. It never asks for, stores, or
                  transmits your provider credentials — sign-in happens in the provider CLI itself, not
                  here.
                </p>
                <div className="privacy">
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="var(--good)"
                    strokeWidth="2.2"
                    style={{ flex: "none" }}
                    aria-hidden="true"
                  >
                    <path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z" />
                    <path d="M9 12l2 2 4-4" />
                  </svg>
                  <div>
                    <b>Zero credential storage</b>
                    <span>
                      Authentication stays in official CLI keychains. QuotaCap never handles or persists
                      tokens.
                    </span>
                  </div>
                </div>
              </div>
              <ProviderReadinessList providers={snapshot.providers} />
              <div className="panel-foot">
                <button className="btn btn-quiet" type="button" onClick={() => setStep(1)}>
                  Back
                </button>
                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={() => setStep(3)}
                >
                  Continue to first poll
                </button>
              </div>
            </section>
          )}

          {step === 3 && (
            <section data-testid="setup-step-3" aria-label="Step 3: Start">
              <div className="panel-head">
                <p className="eyebrow">Step 3 of 3</p>
                <h2>Take the first readings</h2>
                <p>
                  Run the first poll. The daemon will ask each provider CLI for current usage and the
                  dashboard will open when readings land.
                </p>
              </div>
              <SamplePreview />
              <div className="panel-foot">
                <button className="btn btn-quiet" type="button" onClick={() => setStep(2)}>
                  Back
                </button>
                <button
                  data-testid="setup-poll-button"
                  className="btn btn-primary"
                  type="button"
                  onClick={onFirstPoll}
                  disabled={polling}
                >
                  {polling ? "Polling…" : "Run first poll"}
                </button>
              </div>
              {pollError && (
                <div
                  data-testid="setup-poll-error"
                  className="alert"
                  role="alert"
                  style={{ margin: "var(--s4) var(--s5)" }}
                >
                  <span>{pollError}</span>
                  <button className="btn btn-quiet btn-sm" type="button" onClick={onFirstPoll}>
                    Retry
                  </button>
                </div>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

