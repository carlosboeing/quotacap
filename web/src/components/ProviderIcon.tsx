import React from "react";

/** Brand-mark paths from the signed-off concept. Unknown ids fall back to a letter. */
const PATHS: Record<string, string> = {
  kimi: 'M12 7v5l3 2M12 12m-8.5 0a8.5 8.5 0 1 0 17 0a8.5 8.5 0 1 0-17 0',
  claude: "M6 3h8l4 4v14H6zM9 12h6M9 16h6",
  grok: "M12 3.5l2.6 5.5 5.9.8-4.3 4.2 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.8l5.9-.8z",
  codex: "M8 5l10 7-10 7z",
  agy: "M12 4l7 7-7 9-7-9z",
};

function iconKey(id: string): string {
  return id.split(":")[0];
}

export function ProviderIcon({
  id,
  title,
  size = 17,
}: {
  id: string;
  title: string;
  size?: number;
}) {
  const key = iconKey(id);
  const d = PATHS[key];
  if (!d) {
    return <span aria-hidden="true">{title.charAt(0)}</span>;
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {key === "kimi" ? (
        <>
          <path d="M12 7v5l3 2" />
          <circle cx="12" cy="12" r="8.5" />
        </>
      ) : key === "claude" ? (
        <>
          <path d="M6 3h8l4 4v14H6z" />
          <path d="M9 12h6M9 16h6" />
        </>
      ) : (
        <path d={d} />
      )}
    </svg>
  );
}

export function providerTint(id: string): React.CSSProperties {
  const key = iconKey(id);
  return {
    background: `color-mix(in oklch, var(--p-${key}, var(--surface-raised)) 18%, transparent)`,
    color: `var(--p-${key}, var(--ink))`,
  };
}
