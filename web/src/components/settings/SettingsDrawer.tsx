import React, { useEffect, useRef, useState } from "react";
import type { ProviderView } from "../../state.js";
import { ProvidersPanel } from "./ProvidersPanel.js";
import { CliIntegrationPanel } from "./CliIntegrationPanel.js";
import { DaemonPanel } from "./DaemonPanel.js";

type SettingsTab = "providers" | "cli" | "daemon";

const TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: "providers", label: "Providers" },
  { id: "cli", label: "CLI & Shell" },
  { id: "daemon", label: "Daemon" },
];

export function SettingsDrawer({
  open,
  providers,
  onRefresh,
  refreshing,
  onIngested,
  onClose,
}: {
  open: boolean;
  providers: ProviderView[];
  onRefresh: () => void;
  refreshing: boolean;
  onIngested: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<SettingsTab>("providers");
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement;
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      const list = [...focusables].filter((el) => !el.hasAttribute("disabled"));
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      // The dialog container holds focus on open, so a reverse tab from it
      // would otherwise leave the drawer for the page behind.
      const atStart =
        document.activeElement === first || document.activeElement === dialogRef.current;
      if (e.shiftKey && atStart) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      (previouslyFocused.current as HTMLElement | null)?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  const titleId = "settings-drawer-title";

  return (
    <div
      data-testid="settings-scrim"
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 40 }}
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        data-testid="settings-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          bottom: 0,
          width: "min(480px, 90vw)",
          background: "var(--surface)",
          color: "var(--ink)",
          borderLeft: "1px solid var(--line)",
          padding: 16,
          overflowY: "auto",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <h2 id={titleId} style={{ font: "var(--t-4)", flexGrow: 1, margin: 0 }}>
            Settings
          </h2>
          <button type="button" aria-label="Close settings" onClick={onClose}>
            ✕
          </button>
        </div>
        <div role="tablist" aria-label="Settings sections" style={{ display: "flex", gap: 4 }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div role="tabpanel" style={{ marginTop: 12 }}>
          {tab === "providers" && (
            <ProvidersPanel
              providers={providers}
              onRefresh={onRefresh}
              refreshing={refreshing}
              onIngested={onIngested}
            />
          )}
          {tab === "cli" && <CliIntegrationPanel />}
          {tab === "daemon" && <DaemonPanel />}
        </div>
      </div>
    </div>
  );
}
