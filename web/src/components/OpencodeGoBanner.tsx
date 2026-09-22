import React, { useEffect } from "react";
import type { ProviderView, RuntimeView } from "../state.js";

export const OPENCODE_GO_CONSENT_COPY = [
  "• What is read: API key OpenCode already stored when you ran `opencode auth login -p opencode-go` (`~/.local/share/opencode/auth.json`, `opencode-go` → `opencode` fallback).",
  "• Read frequency: in-memory, read-only once per poll (every 15 minutes by default).",
  "• Request destination: sent only as `Authorization: Bearer` to `https://opencode.ai/zen/go/v1/usage` to fetch `rolling/weekly/monthly` `percent` + `resetsAt`.",
  "• Never-list: never used to make chat or model requests, never written or rotated, never stored in the `quotacap` DB, never returned by the API or MCP, and never logged (errors show `[redacted]`).",
  "• Revocation instructions: revoke at `https://opencode.ai/auth` or `opencode providers logout opencode-go` and run `quotacap providers disable opencode-go` to stop polling.",
  "• Optional environment override: if you prefer no file access, set `OPENCODE_API_KEY` instead.",
].join("\n");

export function showOpenCodeGoBanner(
  runtime: Pick<RuntimeView, "detectedProviders"> | undefined,
  providers: Array<Pick<ProviderView, "id" | "enabled">>,
  suppressed: boolean,
): boolean {
  const detected = runtime?.detectedProviders?.includes("opencode-go") ?? false;
  const row = providers.find((p) => p.id === "opencode-go");
  return detected && !row?.enabled && !suppressed;
}

export function OpencodeGoBanner({ onEnable }: { onEnable: () => void }) {
  return (
    <div data-testid="opencode-go-banner" role="status" className="alert">
      <span>
        <strong>OpenCode Go detected.</strong> Enable to track 5h/weekly usage? The API key stays
        with OpenCode until you enable tracking.
      </span>
      <button
        type="button"
        className="linkbtn"
        onClick={onEnable}
        style={{ flex: "none", marginLeft: "auto" }}
      >
        Enable OpenCode Go
      </button>
    </div>
  );
}

export function ConsentModal({
  onConfirm,
  onCancel,
  busy,
}: {
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        display: "grid",
        placeItems: "center",
        background: "var(--scrim, rgba(0,0,0,0.5))",
        zIndex: 60,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="opencode-go-consent-title"
        style={{
          background: "var(--surface)",
          border: "1px solid var(--line)",
          borderRadius: "var(--r-md)",
          padding: "var(--s4) var(--s5)",
          maxWidth: 560,
          margin: "var(--s4)",
        }}
      >
        <h2 id="opencode-go-consent-title" style={{ fontSize: "var(--t-4)", margin: "0 0 var(--s3)" }}>
          Enable OpenCode Go?
        </h2>
        <p style={{ fontSize: "var(--t-2)", color: "var(--ink-soft)", margin: "0 0 var(--s4)", whiteSpace: "pre-line" }}>
          {OPENCODE_GO_CONSENT_COPY}
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--s2)" }}>
          <button type="button" className="btn btn-quiet" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={onConfirm} disabled={busy}>
            {busy ? "Enabling…" : "Enable"}
          </button>
        </div>
      </div>
    </div>
  );
}
