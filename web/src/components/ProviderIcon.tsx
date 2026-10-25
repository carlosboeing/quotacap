import React from "react";

function iconKey(id: string): string {
  return id.split(":")[0];
}

/**
 * Monogram mark: the display name's first letter, tinted by the provider
 * colour through `providerTint`. QuotaCap ships no vendor logos, and the
 * earlier stand-in glyphs (a star for Grok, a page for Claude) read as
 * meaning something they did not.
 */
export function ProviderIcon({
  title,
  size = 17,
}: {
  title: string;
  size?: number;
}) {
  return (
    <span className="pmono" style={{ fontSize: Math.round(size * 0.88) }} aria-hidden="true">
      {title.trim().charAt(0).toUpperCase()}
    </span>
  );
}

export function providerTint(id: string): React.CSSProperties {
  const key = iconKey(id);
  return {
    background: `color-mix(in oklch, var(--p-${key}, var(--surface-raised)) 18%, transparent)`,
    color: `var(--p-${key}, var(--ink))`,
  };
}
