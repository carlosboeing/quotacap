import React from "react";

interface BoundaryProps {
  fallback: React.ReactNode;
  /** A changed key clears a shown fallback and retries the render. */
  resetKey?: unknown;
  children?: React.ReactNode;
}

/**
 * A render crash inside shows fallback UI; the rest of the dashboard
 * survives. Without this, one bad provider unmounts the whole tree into
 * a blank page.
 */
export class ErrorBoundary extends React.Component<BoundaryProps, { error: unknown }> {
  state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error };
  }

  componentDidUpdate(prevProps: BoundaryProps): void {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error !== null) {
      this.setState({ error: null });
    }
  }

  render(): React.ReactNode {
    if (this.state.error !== null) return this.props.fallback;
    return this.props.children;
  }
}

export function CardErrorFallback({ id, name }: { id: string; name: string }) {
  return (
    <article data-testid={`provider-card-${id}-error`} className="pcard" role="alert">
      <div className="pcard-head">
        <div className="who">
          <b>{name}</b>
        </div>
      </div>
      <div className="pcard-body">
        <p className="cell-s">Couldn't show this subscription.</p>
      </div>
    </article>
  );
}

export function RowErrorFallback({ id, name }: { id: string; name: string }) {
  return (
    <div data-testid={`provider-row-${id}-error`} className="lrow" role="alert">
      <div className="prov" data-label="Provider">
        <span>
          <span className="nm">{name}</span>
        </span>
      </div>
      <div data-label="Used vs elapsed">
        <span className="cell-s">Couldn't show this subscription.</span>
      </div>
    </div>
  );
}

export function DrawerErrorFallback({ name, onClose }: { name: string; onClose: () => void }) {
  return (
    <>
      <div
        data-testid="drawer-scrim"
        className="scrim is-open"
        aria-hidden="true"
        onClick={onClose}
      />
      <aside data-testid="provider-drawer-error" role="alert" className="drawer is-open">
        <div className="drawer-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2>{name}</h2>
          </div>
          <button
            className="drawer-close"
            type="button"
            aria-label="Close provider details"
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
        <section className="dsec" aria-label="Details unavailable">
          <p className="cell-s">Couldn't show these details.</p>
        </section>
      </aside>
    </>
  );
}
