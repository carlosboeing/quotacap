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
  onClose,
}: {
  open: boolean;
  providers: ProviderView[];
  onRefresh: () => void;
  refreshing: boolean;
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
    <>
      <div
        data-testid="settings-scrim"
        className="scrim is-open"
        aria-hidden="true"
        onClick={onClose}
      />
      <aside
        ref={dialogRef}
        tabIndex={-1}
        data-testid="settings-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="drawer is-open"
        style={{ width: "min(580px, 100vw)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer-head">
          <div style={{ flex: 1 }}>
            <h2 id={titleId} style={{ margin: "0 0 2px" }}>
              Settings &amp; Configuration
            </h2>
            <span className="sub">
              Connected provider adapters and CLI prompt integration.
            </span>
          </div>
          <button
            className="drawer-close"
            type="button"
            aria-label="Close settings"
            onClick={onClose}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div
          className="seg"
          role="tablist"
          aria-label="Settings sections"
          style={{ margin: "var(--s4) var(--s5) 0", display: "flex", height: 32 }}
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              className={`settings-tab${tab === t.id ? " is-active" : ""}`}
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              style={{ flex: 1, justifyContent: "center" }}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div
          role="tabpanel"
          style={{ padding: "var(--s4) var(--s5) var(--s6)", overflowY: "auto" }}
        >
          {tab === "providers" && (
            <ProvidersPanel
              providers={providers}
              onRefresh={onRefresh}
              refreshing={refreshing}
            />
          )}
          {tab === "cli" && <CliIntegrationPanel />}
          {tab === "daemon" && <DaemonPanel />}
        </div>
      </aside>
    </>
  );
}

