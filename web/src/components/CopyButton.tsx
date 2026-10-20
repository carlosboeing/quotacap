import React, { useEffect, useRef, useState } from "react";

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const handleCopy = async () => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      }
    } catch {
      // Clipboard may be unavailable; still give feedback like the mock.
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };

  return (
    <>
      <button type="button" className="btn btn-quiet btn-sm" onClick={handleCopy}>
        {copied ? "Copied" : "Copy"}
      </button>
      <span className="sr-live" role="status" aria-live="polite">
        {copied ? "Copied to clipboard." : ""}
      </span>
    </>
  );
}
