import React, { useEffect, useRef, useState } from "react";

import type {
  ExclusionReason,
  FailureCategory,
  PaceSource,
  ProviderView,
  RecommendationView,
} from "../state.js";
import { ageDuration, displayPlan, providerSubtitle, shortWindowLabel } from "../state.js";
import {
  Badge,
  PACE_TIPS,
  daysToDuration,
  edgeToken,
  exclusionDetail,
  fillToken,
  forecastLine,
  isEstimated,
  isMonthlyBound,
  isQuotaExhaustedBeforeReset,
  monthlyWindowStartIso,
  paceBadge,
  paceHeadline,
  paceFigures,
  quotaResetsAt,
  quotaWindowName,
  quotaWindowStartIso,
  resetClock,
  resetDateClock,
  timeLeft,
  type PaceBadge,
  type PaceHeadline,
} from "./PaceBar.js";
import { ProviderIcon, providerTint } from "./ProviderIcon.js";
import { BurnDown } from "./BurnDown.js";
import { ClosedWeeks } from "./ClosedWeeks.js";
import { trackFillForPct } from "./WindowsRow.js";
import { laneOf } from "./Recommendation.js";
import { renameProvider } from "../api.js";

export interface DrawerModel {
  id: string;
  name: string;
  badge: PaceBadge;
  burnRate: number | null;
  idealRate: number | null;
  paceSource: PaceSource | null;
  /** "Measured" or "Window avg"; null while pace is unknown. */
  paceLabel: string | null;
  daysLeft: number | null;
  daysToExhaust: number | null;
  remaining: number | null;
  wastePct: number | null;
  periodStart: string | null;
  resetsAt: string | null;
  estimatedReset: boolean;
  lastSuccessAt: string | null;
  ageMs: number | null;
  failureCategory: FailureCategory;
  failureWords: string | null;
  evidence: string[];
  exclusionReason: ExclusionReason;
  exclusionWords: string | null;
  fiveHourPct?: number;
  /** Reported 5h reset only; never synthesized from the window length. */
  fiveHourResetsAt?: string;
  monthlyPct?: number;
  monthlyResetsAt?: string;
  monthlyStatus?: "ok" | "exhausted";
  monthlyKind?: "included";
}

export function exclusionWords(reason: ExclusionReason): string | null {
  switch (reason) {
    case "not-reporting":
      return "Not reporting yet.";
    case "stale":
      return "Stale — excluded from ranking.";
    case "reset-passed":
      return "Reset passed — awaiting a fresh window.";
    case "invalid":
      return "Reading invalid — excluded from ranking.";
    case "provider-failed":
      return "Provider failed — excluded from ranking.";
    case null:
      return null;
  }
}

export function failureWords(category: FailureCategory): string | null {
  switch (category) {
    case "auth":
      return "Authentication failed";
    case "timeout":
      return "Timed out";
    case "parse":
      return "Unreadable output";
    case "network":
      return "Network error";
    case "skipped":
      return "Skipped";
    case "unknown":
      return "Unknown error";
    case null:
      return null;
  }
}

/** Drawer fields copied from the server snapshot. Nothing is synthesized. */
export function drawerModel(provider: ProviderView): DrawerModel {
  const advisory = provider.advisory;
  const model: DrawerModel = {
    id: provider.id,
    name: provider.displayName,
    badge: paceBadge(provider),
    burnRate: advisory?.burnRate ?? null,
    idealRate: advisory ? advisory.idealRate : null,
    paceSource: advisory ? advisory.paceSource : null,
    paceLabel:
      advisory && advisory.burnMeasured
        ? "Measured"
        : advisory && advisory.paceSource === "window-average"
          ? "Window avg"
          : null,
    daysLeft: advisory ? advisory.daysLeft : null,
    daysToExhaust: advisory?.daysToExhaust ?? null,
    remaining: advisory ? advisory.remaining : null,
    wastePct: advisory?.wastePct ?? null,
    periodStart: provider.quota ? provider.quota.periodStart : null,
    resetsAt: provider.quota ? provider.quota.resetsAt : null,
    estimatedReset: provider.evidence.includes("estimated-reset"),
    lastSuccessAt: provider.lastSuccessAt,
    ageMs: provider.ageMs,
    failureCategory: provider.lastAttempt?.failureCategory ?? null,
    failureWords:
      provider.lastAttempt?.summary ?? failureWords(provider.lastAttempt?.failureCategory ?? null),
    evidence: [...provider.evidence],
    exclusionReason: provider.exclusionReason,
    exclusionWords: exclusionWords(provider.exclusionReason),
  };
  if (provider.quota?.fiveHourPct !== undefined && provider.quota.fiveHourPct !== null) {
    model.fiveHourPct = provider.quota.fiveHourPct;
  }
  if (provider.quota?.fiveHourResetsAt) {
    model.fiveHourResetsAt = provider.quota.fiveHourResetsAt;
  }
  const q = provider.quota;
  if (q?.monthlyKind === "included") {
    model.monthlyKind = q.monthlyKind;
    if (q.monthlyPct !== undefined) model.monthlyPct = q.monthlyPct;
    if (q.monthlyResetsAt !== undefined) model.monthlyResetsAt = q.monthlyResetsAt;
    if (q.monthlyStatus !== undefined) model.monthlyStatus = q.monthlyStatus;
  }
  return model;
}

export function sourceLabel(source: string | undefined | null): string {
  switch (source) {
    case "cli":
      return "Live CLI";
    case "api":
      return "Live API";
    case "tui":
      return "Live TUI";
    case "scrape":
      return "Live scrape";
    case "manual":
      return "Manual ingest";
    default:
      return source || "unknown";
  }
}

export function paceBasis(provider: ProviderView, asOfMs?: number): string {
  const advisory = provider.advisory;
  if (!advisory) return "No current reading";
  // A monthly-bound Pace section still has a quota average even when the
  // weekly pace is unknown, so only weekly-bound rows gate on paceSource.
  if (!isMonthlyBound(provider) && advisory.paceSource === "unknown") return "No current reading";
  const startIso = quotaWindowStartIso(provider);
  const start = startIso ? Date.parse(startIso) : NaN;
  const isExhausted =
    (provider.quota && provider.quota.weeklyPct >= 100) ||
    (advisory.bindingRemaining <= 0);
  const endMs =
    isExhausted && advisory.exhaustedAt ? Date.parse(advisory.exhaustedAt) : asOfMs;
  if (Number.isFinite(start) && Number.isFinite(endMs) && (endMs as number) > start) {
    const days = ((endMs as number) - start) / 86_400_000;
    if (days >= 0.1) {
      if (isExhausted && advisory.exhaustedAt) {
        return `averaged over ${days.toFixed(1)} days to reach 100%`;
      }
      return `averaged over ${days.toFixed(1)} days of this window`;
    }
  }
  if (provider.evidence.includes("measured") || advisory.burnMeasured) return "Measured";
  if (advisory.paceSource === "window-average" || provider.evidence.includes("window-average")) {
    return "Window avg";
  }
  return "No current reading";
}

export function credentialLabel(provider: ProviderView): string {
  const source = provider.quota?.source;
  if (provider.id === "opencode-go" && source === "api") {
    return "read in-memory from OpenCode auth (opt-in), never stored";
  }
  if (source === "cli" || source === "tui") return `handled by ${provider.displayName}`;
  return "not stored by QuotaCap";
}

export function resetStamp(provider: ProviderView): string | null {
  if (!provider.quota) return null;
  const clock = resetClock(provider.quota.resetsAt);
  if (!clock) return null;
  return `${clock}${isEstimated(provider) ? " (est.)" : ""}`;
}

export function resetUnderline(provider: ProviderView, asOfMs: number): string | null {
  const stamp = resetStamp(provider);
  if (!stamp || !provider.quota) return null;
  const left = timeLeft(provider.quota.resetsAt, asOfMs);
  return left ? `Resets ${stamp} · in ${left}` : `Resets ${stamp}`;
}

/** Weekly reset split for the emphasized drawer line. */
export function resetUnderlineParts(
  provider: ProviderView,
  asOfMs: number,
): { stamp: string; left: string | null } | null {
  const stamp = resetStamp(provider);
  if (!stamp || !provider.quota) return null;
  return { stamp, left: timeLeft(provider.quota.resetsAt, asOfMs) };
}

/**
 * Reported 5h reset as a quiet sub-line, or null when the provider did not
 * report one. A passed stamp reads as past, never as the next reset.
 */
export function fiveHourResetLine(provider: ProviderView, asOfMs: number): string | null {
  const iso = provider.quota?.fiveHourResetsAt;
  if (!iso) return null;
  const clock = resetClock(iso);
  if (!clock) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  if (ms <= asOfMs) return `Reset ${clock}`;
  const left = timeLeft(iso, asOfMs);
  return left ? `Resets ${clock} · in ${left}` : `Resets ${clock}`;
}

/**
 * Fill for a rolling (rate-limit) row: neutral below the cap threshold so
 * colour never implies a pace judgement, cap red at 80%+ or exhausted.
 */
export function limitFill(pct: number, exhausted = false): React.CSSProperties {
  const base = trackFillForPct(pct, exhausted);
  if (!exhausted && pct < 80) {
    return { ...base, background: "var(--fill-out)", ["--fill-edge" as string]: "var(--edge-out)" };
  }
  return base;
}

/** Elapsed share of a window from its start and reset stamps. Null when either stamp is unusable. */
export function windowElapsedPct(
  startIso: string | null | undefined,
  resetIso: string | null | undefined,
  asOfMs: number,
): number | null {
  if (!startIso || !resetIso) return null;
  const startMs = Date.parse(startIso);
  const resetMs = Date.parse(resetIso);
  if (!Number.isFinite(startMs) || !Number.isFinite(resetMs) || resetMs <= startMs) return null;
  if (!Number.isFinite(asOfMs)) return null;
  return Math.min(100, Math.max(0, ((asOfMs - startMs) / (resetMs - startMs)) * 100));
}

/**
 * Elapsed share of the monthly window. Providers report only the monthly
 * reset, so the window start is one calendar month before it.
 */
export function monthlyElapsedPct(provider: ProviderView, asOfMs: number): number | null {
  const resetIso = provider.quota?.monthlyResetsAt;
  if (!resetIso) return null;
  const startIso = monthlyWindowStartIso(resetIso);
  if (!startIso) return null;
  return windowElapsedPct(startIso, resetIso, asOfMs);
}

/** Elapsed share of the 5h window, from its reported reset. Null when no reset was reported. */
export function fiveHourElapsedPct(provider: ProviderView, asOfMs: number): number | null {
  const resetIso = provider.quota?.fiveHourResetsAt;
  if (!resetIso) return null;
  const resetMs = Date.parse(resetIso);
  if (!Number.isFinite(resetMs) || resetMs <= asOfMs) return null;
  const start = new Date(resetMs - 5 * 3_600_000);
  return windowElapsedPct(start.toISOString(), resetIso, asOfMs);
}

/** Monthly reset split (date clock plus countdown) for the limit row. */
export function monthlyResetParts(
  provider: ProviderView,
  asOfMs: number,
): { stamp: string; left: string | null } | null {
  const resetIso = provider.quota?.monthlyResetsAt;
  if (!resetIso) return null;
  const stamp = resetDateClock(resetIso);
  if (!stamp) return null;
  return { stamp, left: timeLeft(resetIso, asOfMs) };
}

/** Monthly reset split for the emphasized drawer line. */
export function monthlyMetaParts(
  provider: ProviderView,
): { stamp: string; detail: string | null } | null {
  const q = provider.quota;
  if (q?.monthlyKind !== "included" || !q.monthlyResetsAt) return null;
  const clock = resetDateClock(q.monthlyResetsAt);
  const stamp = clock ? `Resets ${clock}` : "Reset unknown";
  const adv = provider.advisory;
  if (q.monthlyStatus === "exhausted" || (adv?.bindingWindow === "monthly" && adv.bindingRemaining === 0)) {
    return { stamp, detail: "weekly leftover unused until then" };
  }
  if (adv?.bindingWindow === "monthly") {
    return { stamp, detail: `${Math.round(adv.bindingRemaining)}% of month left` };
  }
  return { stamp, detail: null };
}

/** Monthly section meta line. Null when the provider has no included monthly window. */
export function monthlyMeta(provider: ProviderView): string | null {
  const parts = monthlyMetaParts(provider);
  if (!parts) return null;
  return parts.detail ? `${parts.stamp} · ${parts.detail}` : parts.stamp;
}

export type VerdictTone = "use-more" | "ease-off" | "neutral";

export interface Verdict {
  tone: VerdictTone;
  label: string;
  detail: string | null;
}

/**
 * Drawer verdict band from lane, binding window, and forecast fields.
 * Precedence: excluded or monthly-exhausted, monthly-bound, use-more lane,
 * ease-off lane or at-risk/watch status, otherwise on track.
 */
export function verdictFor(provider: ProviderView, asOfMs?: number): Verdict {
  const advisory = provider.advisory;
  const age = ageDuration(provider.ageMs);
  const monthlyExhausted =
    !!advisory && advisory.bindingWindow === "monthly" && advisory.bindingRemaining === 0;
  if (provider.exclusionReason !== null) {
    const detailWord = exclusionDetail(provider.exclusionReason);
    let detail: string | null;
    if (detailWord && age) detail = `${detailWord} · last read ${age} ago`;
    else if (detailWord) detail = detailWord;
    else if (age) detail = `last read ${age} ago`;
    else detail = forecastLine(provider);
    return { tone: "neutral", label: "• Not ranked", detail };
  }
  if (monthlyExhausted) {
    return { tone: "neutral", label: "• Not ranked", detail: forecastLine(provider) };
  }
  if (!advisory) {
    return { tone: "neutral", label: "• On track", detail: forecastLine(provider) };
  }
  if (advisory.bindingWindow === "monthly" && advisory.bindingRemaining > 0) {
    return {
      tone: "use-more",
      label: "↑ Use more",
      detail: `${Math.round(advisory.bindingRemaining)}% of month left`,
    };
  }
  const lane = laneOf(advisory, provider.exclusionReason);
  if (lane === "use-more") {
    const waste =
      advisory.wastePct !== null && Number.isFinite(advisory.wastePct)
        ? Math.round(advisory.wastePct)
        : null;
    const quotaReset = quotaResetsAt(provider);
    const left =
      quotaReset && asOfMs !== undefined
        ? timeLeft(quotaReset, asOfMs)
        : Number.isFinite(advisory.bindingDaysLeft ?? advisory.daysLeft)
          ? daysToDuration(advisory.bindingDaysLeft ?? advisory.daysLeft)
          : null;
    const detail =
      waste !== null && left
        ? `${waste}% waste forecast · resets in ${left}`
        : waste !== null
          ? `${waste}% waste forecast`
          : forecastLine(provider);
    return { tone: "use-more", label: "↑ Use more", detail };
  }
  if (lane === "ease-off" || advisory.status === "at risk" || advisory.status === "watch") {
    const detail =
      advisory.remaining <= 0 || paceBadge(provider) === "Quota exhausted"
        ? "quota fully used"
        : advisory.daysToExhaust !== null && Number.isFinite(advisory.daysToExhaust)
          ? `exhausts in ${daysToDuration(advisory.daysToExhaust)} at current pace`
          : paceBadge(provider);
    return { tone: "ease-off", label: "↓ Ease off", detail };
  }
  return { tone: "neutral", label: "• On track", detail: forecastLine(provider) };
}

export interface RenameSubmitResult {
  success: boolean;
  error: string | null;
}

export async function submitProviderRename(
  id: string,
  rawDraft: string,
  renameFn: (id: string, name: string | null) => Promise<void>
): Promise<RenameSubmitResult> {
  const trimmed = rawDraft.trim();
  const newName = trimmed.length === 0 ? null : trimmed;
  try {
    await renameFn(id, newName);
    return { success: true, error: null };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to update display name" };
  }
}

/**
 * Compact forecast for a drawer limit line. The verdict band and Pace
 * section carry the full pace story, so the row keeps only the outcome:
 * status words and "at current pace" are dropped, and a status-only
 * headline with no figure is left to the verdict.
 */
export function compactLimitForecast(provider: ProviderView): PaceHeadline | null {
  if (provider.exclusionReason !== null) return null;
  const headline = paceHeadline(provider);
  if (!headline || headline.kind === "ontrack") return null;
  const text = headline.text
    .replace(/^(Cap risk|Watch) · /, "")
    .replace(/^Measuring pace · /, "")
    .replace(/^Exhausted · /, "")
    .replace(/ at current pace$/, "");
  if (!/\d/.test(text) && text !== "quota fully used") return null;
  return { ...headline, text };
}

/**
 * One limit row, identical for every window: title line (with the
 * Quota reset tag on the quota window only), the reset line
 * left-aligned under the title, then the bar. The vertical mark is the
 * elapsed share of the window, so usage can be read against time.
 */
function LimitRow({
  name,
  pct,
  quota,
  resetLine,
  forecast,
  hatchPct,
  fillStyle,
  elapsedPct,
  testId,
}: {
  name: string;
  pct: number;
  quota?: boolean;
  resetLine: React.ReactNode;
  forecast?: { text: string; kind: string } | null;
  /** Projected-unused share of the quota bar, hatched like the card bar. */
  hatchPct?: number | null;
  fillStyle: React.CSSProperties;
  elapsedPct: number | null;
  testId?: string;
}) {
  const label =
    elapsedPct !== null
      ? `${pct} percent of ${name.toLowerCase()} used, ${Math.round(elapsedPct)} percent of the window elapsed`
      : `${pct} percent of ${name.toLowerCase()} used`;
  return (
    <div className="limit-row" data-testid={testId}>
      <div className="limit-head">
        <span className="limit-name">{name}</span>
        {quota && <span className="quota-tag">Quota reset</span>}
        <span className="limit-pct">{pct}% used</span>
      </div>
      <div className="limit-sub">
        {resetLine}
        {forecast && <span className={`out out-${forecast.kind}`}>→ {forecast.text}</span>}
      </div>
      <div className="track" role="img" aria-label={label}>
        <div className="fill" style={fillStyle} />
        {hatchPct !== null && hatchPct !== undefined && Number.isFinite(hatchPct) && (
          <div
            aria-hidden="true"
            data-testid="limit-hatch"
            className="band band-waste"
            style={{ left: `${100 - hatchPct}%`, width: `${hatchPct}%` }}
          />
        )}
        {elapsedPct !== null && (
          <div
            aria-hidden="true"
            className="mark"
            title={`Time elapsed: ${Math.round(elapsedPct)}%`}
            style={{ left: `${elapsedPct}%` }}
          />
        )}
      </div>
    </div>
  );
}

export function ProviderDrawer({
  provider,
  asOf,
  recommendation,
  onClose,
  onRenamed,
  renameAction,
}: {
  provider: ProviderView | null;
  asOf: string;
  recommendation: RecommendationView | null;
  onClose: () => void;
  onRenamed?: () => void;
  renameAction?: (id: string, displayName: string | null) => Promise<void>;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<Element | null>(null);

  const [isEditing, setIsEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState(provider?.displayName ?? "");
  const [saving, setSaving] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  useEffect(() => {
    if (provider) {
      setNameDraft(provider.displayName);
      setIsEditing(false);
      setRenameError(null);
    }
  }, [provider?.id, provider?.displayName]);

  useEffect(() => {
    if (!provider) return;
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
  }, [provider, onClose]);

  const handleSubmitRename = async (e: React.FormEvent) => {

    e.preventDefault();
    if (!provider) return;
    setSaving(true);
    setRenameError(null);
    const result = await submitProviderRename(
      provider.id,
      nameDraft,
      renameAction ?? renameProvider
    );
    if (result.success) {
      setIsEditing(false);
      onRenamed?.();
    } else {
      setRenameError(result.error);
    }
    setSaving(false);
  };


  if (!provider) return null;
  const model = drawerModel(provider);
  const titleId = "provider-drawer-title";
  const asOfMs = Date.parse(asOf);
  const updated = ageDuration(model.ageMs);
  const underlineParts = resetUnderlineParts(provider, asOfMs);
  const planBits = [displayPlan(provider.quota?.plan), sourceLabel(provider.quota?.source)].filter(
    (b) => b && b !== "unknown"
  );
  const sub = planBits.join(" · ");
  const monthlyReset = monthlyResetParts(provider, asOfMs);
  // Per-window elapsed for the Limits rows; the Pace bar's quota geometry
  // would hand the weekly row the monthly share on a monthly-bound provider.
  const weeklyElapsed = provider.quota
    ? windowElapsedPct(provider.quota.periodStart, provider.quota.resetsAt, asOfMs)
    : null;
  const monthlyElapsed = monthlyElapsedPct(provider, asOfMs);
  const fiveElapsed = fiveHourElapsedPct(provider, asOfMs);
  // The quota (binding) window leads the Limits
  // section; rolling windows (5h, and weekly for monthly-bound providers)
  // are rate limits and follow as secondary rows.
  const monthlyPrimary =
    provider.advisory?.bindingWindow === "monthly" &&
    model.monthlyKind === "included" &&
    model.monthlyPct !== undefined &&
    Number.isFinite(model.monthlyPct);
  const verdict = verdictFor(provider, asOfMs);
  const notes: { key: string; dot: "warn" | "bad"; text: string }[] = [];
  if (model.exclusionWords) notes.push({ key: "exclusion", dot: "warn", text: model.exclusionWords });
  if (model.failureWords) notes.push({ key: "failure", dot: "bad", text: model.failureWords });
  if (model.estimatedReset) notes.push({ key: "estimated", dot: "warn", text: "Reset time is estimated." });
  const footBits = [
    provider.quota ? sourceLabel(provider.quota?.source) : null,
    displayPlan(provider.quota?.plan),
    updated ? `Updated ${updated} ago` : "Updated unknown",
  ].filter(Boolean) as string[];
  let footText = footBits.join(" · ");
  if ((provider.stale || provider.exclusionReason === "stale") && model.failureWords) {
    footText += ` · ${model.failureWords}`;
  }
  const showCredential = provider.id === "opencode-go" && provider.quota?.source === "api";
  const paceFigs = paceFigures(provider.advisory);
  const paceBasisLine =
    provider.advisory && paceFigs.avg === null && paceFigs.recent !== null
      ? PACE_TIPS.recent
      : paceBasis(provider, asOfMs);

  const weeklyResetLine = underlineParts ? (
    <div className="winrow-sub reset-line">
      Resets <strong>{underlineParts.stamp}</strong>
      {underlineParts.left && (
        <>
          {" "}· in <strong>{underlineParts.left}</strong>
        </>
      )}
    </div>
  ) : (
    <div className="winrow-sub">Reset not reported</div>
  );
  const monthlyResetLine = monthlyReset ? (
    <div className="winrow-sub reset-line">
      Resets <strong>{monthlyReset.stamp}</strong>
      {monthlyReset.left && (
        <>
          {" "}· in <strong>{monthlyReset.left}</strong>
        </>
      )}
    </div>
  ) : (
    <div className="winrow-sub">Reset not reported</div>
  );
  const fiveClock = model.fiveHourResetsAt ? resetClock(model.fiveHourResetsAt) : null;
  const fiveLeft =
    model.fiveHourResetsAt && fiveClock ? timeLeft(model.fiveHourResetsAt, asOfMs) : null;
  const fiveResetLineNode = !fiveClock ? (
    <div className="winrow-sub">Reset not reported</div>
  ) : fiveLeft ? (
    <div className="winrow-sub reset-line">
      Resets <strong>{fiveClock}</strong> · in <strong>{fiveLeft}</strong>
    </div>
  ) : (
    <div className="winrow-sub reset-line">
      Reset <strong>{fiveClock}</strong>
    </div>
  );

  const headline = provider.exclusionReason === null ? paceHeadline(provider) : null;
  const limitForecast = compactLimitForecast(provider);
  const wastePct = provider.advisory?.wastePct ?? null;
  const weeklyHatchPct = !monthlyPrimary && headline?.hatch ? wastePct : null;

  const isWeekly100 =
    provider.quota &&
    !provider.resetPassed &&
    provider.quota.weeklyPct >= 100 &&
    (!provider.quota.resetsAt || Date.parse(provider.quota.resetsAt) > asOfMs);

  const weeklyRow = provider.quota ? (
    <LimitRow
      name="Weekly limit"
      pct={provider.quota.weeklyPct}
      quota={!monthlyPrimary}
      resetLine={weeklyResetLine}
      forecast={monthlyPrimary ? null : limitForecast}
      hatchPct={weeklyHatchPct}
      fillStyle={
        monthlyPrimary
          ? limitFill(provider.quota.weeklyPct)
          : isWeekly100
            ? {
                width: `${Math.min(100, Math.max(0, provider.quota.weeklyPct))}%`,
                background: "var(--fill-cap)",
                ["--fill-edge" as string]: "var(--edge-cap)",
              }
            : {
                width: `${Math.min(100, Math.max(0, provider.quota.weeklyPct))}%`,
                background: fillToken(model.badge),
                ["--fill-edge" as string]: edgeToken(model.badge),
              }
      }
      elapsedPct={weeklyElapsed}
    />
  ) : null;
  const monthlyRow =
    model.monthlyKind === "included" &&
    model.monthlyPct !== undefined &&
    Number.isFinite(model.monthlyPct) ? (
      <LimitRow
        name="Monthly limit"
        pct={model.monthlyPct}
        quota={monthlyPrimary}
        resetLine={monthlyResetLine}
        forecast={monthlyPrimary ? limitForecast : null}
        fillStyle={
          monthlyPrimary
            ? trackFillForPct(model.monthlyPct, model.monthlyStatus === "exhausted")
            : limitFill(model.monthlyPct, model.monthlyStatus === "exhausted")
        }
        elapsedPct={monthlyElapsed}
        testId="drawer-monthly"
      />
    ) : null;
  const fiveResetPassed =
    model.fiveHourResetsAt !== undefined &&
    Number.isFinite(Date.parse(model.fiveHourResetsAt)) &&
    Date.parse(model.fiveHourResetsAt) <= asOfMs;
  const effectiveFivePct = fiveResetPassed ? 0 : model.fiveHourPct;
  const fiveRow =
    model.fiveHourPct !== undefined &&
    model.fiveHourPct !== null &&
    Number.isFinite(model.fiveHourPct) ? (
      <LimitRow
        name={shortWindowLabel(provider.id) ?? "5h limit"}
        pct={effectiveFivePct ?? 0}
        resetLine={fiveResetLineNode}
        fillStyle={limitFill(effectiveFivePct ?? 0)}
        elapsedPct={fiveResetPassed ? null : fiveElapsed}
      />
    ) : null;
  const anyElapsed = [weeklyElapsed, monthlyElapsed, fiveElapsed].some((v) => v !== null);

  return (
    <>
      <div
        data-testid="drawer-scrim"
        className="scrim is-open"
        aria-hidden="true"
        onClick={onClose}
      />
      <aside
        ref={dialogRef}
        tabIndex={-1}
        data-testid="provider-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="drawer is-open"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer-head">
          <span className="picon" style={providerTint(provider.id)}>
            <ProviderIcon id={provider.id} title={model.name} />
          </span>
          <div className="who" style={{ flex: 1, minWidth: 0 }}>
            <h2
              id={titleId}
              style={
                isEditing
                  ? {
                      position: "absolute",
                      width: 1,
                      height: 1,
                      padding: 0,
                      margin: -1,
                      overflow: "hidden",
                      clip: "rect(0, 0, 0, 0)",
                      border: 0,
                    }
                  : {
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "var(--s1)",
                    }
              }
            >
              <span>{model.name}</span>
              {!isEditing && (
                <button
                  type="button"
                  className="rename-btn"
                  aria-label={`Rename ${model.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsEditing(true);
                  }}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                  </svg>
                </button>
              )}
            </h2>
            {isEditing && (
              <form
                onSubmit={handleSubmitRename}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--s1)",
                  marginBottom: "var(--s2)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "var(--s2)" }}>
                  <input
                    type="text"
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.stopPropagation();
                        setIsEditing(false);
                        setNameDraft(provider.displayName);
                        setRenameError(null);
                      }
                    }}
                    autoFocus
                    maxLength={32}
                    placeholder={provider.builtinName ?? provider.id}
                    aria-label="Provider display name"
                    style={{
                      font: "inherit",
                      fontSize: "var(--t-4)",
                      fontWeight: 600,
                      padding: "4px 8px",
                      borderRadius: "var(--r-sm)",
                      border: "1px solid var(--line)",
                      background: "var(--surface)",
                      color: "var(--ink)",
                      width: "100%",
                      maxWidth: "240px",
                    }}
                  />
                  <button
                    type="submit"
                    disabled={saving}
                    className="btn btn-sm"
                    style={{ flex: "none" }}
                  >
                    {saving ? "Saving…" : "Save"}
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => {
                      setIsEditing(false);
                      setNameDraft(provider.displayName);
                      setRenameError(null);
                    }}
                    className="btn btn-quiet btn-sm"
                    style={{ flex: "none" }}
                  >
                    Cancel
                  </button>
                </div>
                {renameError && (
                  <span style={{ fontSize: "var(--t-2)", color: "var(--danger)" }}>
                    {renameError}
                  </span>
                )}
              </form>
            )}
            {provider.builtinName && provider.displayName !== provider.builtinName && (
              <div
                className="sub"
                style={{ marginTop: "2px" }}
                data-testid="provider-builtin-name"
              >
                {`Built-in: ${provider.builtinName}`}
              </div>
            )}
            <span className="sub">{providerSubtitle(provider) ?? sub}</span>
          </div>

          <Badge provider={provider} compact />

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

        <div className={`verdict ${verdict.tone}`} data-testid="drawer-verdict">
          <b>{verdict.label}</b>
          {verdict.detail && <span>{verdict.detail}</span>}
        </div>

        {provider.description && <p className="drawer-desc">{provider.description}</p>}

        {notes.length > 0 && (
          <section className="dsec" aria-label="Notes">
            <h3>Notes</h3>
            <div className="notes-list">
              {notes.map((n) => (
                <div key={n.key} className="note">
                  <span className={`dot ${n.dot}`} aria-hidden="true" />
                  <span>{n.text}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="dsec" aria-label="Limits">
          <h3>Limits</h3>
          {provider.quota ? (
            <>
              {monthlyPrimary ? (
                <>
                  {monthlyRow}
                  {weeklyRow}
                  {fiveRow}
                </>
              ) : (
                <>
                  {weeklyRow}
                  {fiveRow}
                  {monthlyRow}
                </>
              )}
              {(anyElapsed || weeklyHatchPct !== null) && (
                <p className="limit-legend">
                  <span className="legend-label">Legend</span>
                  {anyElapsed && (
                    <span className="legend-item">
                      <span className="legend-mark" aria-hidden="true" />
                      Time elapsed
                    </span>
                  )}
                  {weeklyHatchPct !== null && (
                    <span className="legend-item">
                      <span className="legend-hatch" aria-hidden="true" />
                      Projected waste
                    </span>
                  )}
                </p>
              )}
            </>
          ) : (
            <p className="cell-s">No readings yet.</p>
          )}
        </section>

        <BurnDown provider={provider} asOf={asOf} basis={paceBasisLine} />

        <ClosedWeeks closes={provider.lastCloses} windowName={quotaWindowName(provider)} />

        <div className="prov-foot">
          {footText}
          {showCredential && <span className="cred">{credentialLabel(provider)}</span>}
        </div>
      </aside>
    </>
  );
}

