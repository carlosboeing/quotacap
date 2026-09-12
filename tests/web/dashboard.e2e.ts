import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Browser, type Page } from "@playwright/test";
import { startStub, type StubHandle, type StubOptions } from "./stub-server.js";
import { hatchGradient } from "../../web/src/components/PaceBar.js";
import {
  exampleStateSnapshotJson,
  staleStateSnapshotJson,
  resetPassedStateSnapshotJson,
  unknownPaceStateSnapshotJson,
} from "../fixtures/stable-state.js";

/**
 * Fixture-driven dashboard suite. The stub serves Track A fixture JSON
 * verbatim plus the real Vite build; no server source is imported.
 */

const liveStubs: StubHandle[] = [];
test.afterEach(async () => {
  while (liveStubs.length > 0) {
    const stub = liveStubs.pop();
    if (stub) await stub.stop();
  }
});

async function stubFor(state: unknown, extra?: Omit<StubOptions, "state">): Promise<StubHandle> {
  const stub = await startStub({ state, ...extra });
  liveStubs.push(stub);
  return stub;
}

/**
 * Screenshots are test output, not documentation. They default to the
 * gitignored `test-results/` scratch dir, per checkout so a worktree never
 * writes into the main one.
 *
 * A workbench `assets/` folder holds assets that support a document — UX
 * mocks and the like — so a test must not write there by default. It used to,
 * at a hardcoded plan path, which overwrote committed doc assets on every run.
 * Set QUOTACAP_ASSETS_DIR to refresh those deliberately.
 */
function assetsDir(): string {
  const override = process.env.QUOTACAP_ASSETS_DIR;
  if (override && override.length > 0) {
    fs.mkdirSync(override, { recursive: true });
    return override;
  }
  const specDir = path.dirname(fileURLToPath(import.meta.url));
  const dir = path.join(specDir, "..", "..", "test-results", "dashboard-screenshots");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const ASSETS = assetsDir();

function shot(page: Page, name: string): Promise<Buffer> {
  return page.screenshot({ path: path.join(ASSETS, name) });
}

type Theme = "light" | "dark";

async function themedPage(browser: Browser, theme: Theme, width: number, height = 900) {
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme: theme,
  });
  const page = await context.newPage();
  return { context, page };
}

function focusInside(page: Page, testId: string): Promise<boolean> {
  return page.evaluate((id) => {
    const dialog = document.querySelector(`[data-testid="${id}"]`);
    return !!dialog && dialog.contains(document.activeElement);
  }, testId);
}

async function expectNoPageOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(1); // sub-pixel tolerance
}

const exampleState = () => JSON.parse(exampleStateSnapshotJson);
const reasonOf = (s: any): string => s.recommendation.reason as string;
const recWaste = (s: any): string =>
  s.recommendation.wastePct !== null && s.recommendation.wastePct !== undefined
    ? `${Math.round(s.recommendation.wastePct)}%`
    : reasonOf(s);

/** First-run server state: every provider present, no quota rows stored. */
function firstRunState(): any {
  const s = exampleState();
  return {
    ...s,
    providers: s.providers.map((p: any) => ({
      ...p,
      quota: null,
      lastAttempt: null,
      lastSuccessAt: null,
      reporting: false,
      stale: false,
      resetPassed: false,
      ageMs: null,
      evidence: [],
      exclusionReason: "not-reporting",
      advisory: null,
    })),
    recommendation: {
      use: "none",
      reason: "no quotas yet",
      wastePct: null,
      idealRate: 0,
      recommendationBasis: "none",
      alternatives: [],
      advisories: [],
    },
  };
}

/** Balanced server state: nothing needs priority, lanes stay empty. */
function balancedState(): any {
  const s = exampleState();
  const calm = (a: any) =>
    a ? { ...a, status: "on track", wastePct: 0, urgency: "on track" } : a;
  return {
    ...s,
    providers: s.providers.map((p: any) =>
      p.exclusionReason === null ? { ...p, advisory: calm(p.advisory) } : p
    ),
    recommendation: {
      ...s.recommendation,
      use: "none",
      reason: "No subscription needs priority",
      wastePct: 0,
      recommendationBasis: "none",
      advisories: s.recommendation.advisories.map((a: any) => ({ ...a, urgency: "on track" })),
    },
  };
}

/** One reset pushed past the 7-day rail for the overflow chip. */
function farResetState(): any {
  const s = exampleState();
  const far = new Date(Date.parse(s.asOf) + 30 * 24 * 60 * 60 * 1000).toISOString();
  return {
    ...s,
    providers: s.providers.map((p: any) =>
      p.id === "kimi" && p.quota ? { ...p, quota: { ...p.quota, resetsAt: far } } : p
    ),
  };
}

/** Resets spread a day apart so every pin places without clustering. */
function spreadResetState(): any {
  const s = exampleState();
  const asOfMs = Date.parse(s.asOf);
  const dayOf: Record<string, number> = {
    kimi: 1,
    claude: 2,
    codex: 3,
    "my-plan": 4,
    agy: 5,
    "agy:3p": 6,
  };
  return {
    ...s,
    providers: s.providers.map((p: any) => {
      const day = dayOf[p.id];
      if (day === undefined || !p.quota) return p;
      return {
        ...p,
        quota: { ...p.quota, resetsAt: new Date(asOfMs + day * 24 * 60 * 60 * 1000).toISOString() },
      };
    }),
  };
}

test("renders recommendation advice with forecast waste percentage", async ({ page }) => {
  const stub = await stubFor(exampleState());
  await page.goto(stub.url);
  await expect(page.getByTestId("rec-prose")).toContainText(recWaste(exampleState()));
});

const VIEWPORTS = [320, 390, 768, 1440];
const THEMES: Theme[] = ["light", "dark"];

test("dashboard renders in every viewport and theme without page overflow", async ({
  browser,
}) => {
  const stub = await stubFor(exampleState());
  for (const width of VIEWPORTS) {
    for (const theme of THEMES) {
      const { context, page } = await themedPage(browser, theme, width);
      try {
        await page.goto(stub.url);
        await expect(page.getByTestId("rec-prose")).toContainText(recWaste(exampleState()));
        await expectNoPageOverflow(page);
        await shot(page, `dashboard-${width}-${theme}.png`);
      } finally {
        await context.close();
      }
    }
  }
});

async function expectLabeledChrome(page: Page) {
  await expect(page.getByTestId("rec-prose")).toContainText(recWaste(exampleState()));
  await expect(page.getByRole("heading", { name: /quota advice & pacing/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: /upcoming resets/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: /all subscriptions/i })).toBeVisible();
  await expect(page.getByTestId("view-advice")).toBeVisible();
  await expect(page.getByLabel(/Sort by/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Cards" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Table" })).toBeVisible();
  const refreshLabel = page.locator('[data-testid="refresh-button"] .btn-label');
  const settingsLabel = page.locator('[data-testid="settings-button"] .btn-label');
  await expect(refreshLabel).toBeVisible();
  await expect(refreshLabel).toHaveText("Refresh");
  await expect(refreshLabel).not.toHaveCSS("display", "none");
  await expect(settingsLabel).toBeVisible();
  await expect(settingsLabel).toHaveText("Settings");
  await expect(settingsLabel).not.toHaveCSS("display", "none");
}

test("dashboard chrome matches the signed-off section structure", async ({ browser }) => {
  const stub = await stubFor(exampleState());
  for (const width of [1440, 390] as const) {
    const { context, page } = await themedPage(browser, "light", width);
    try {
      await page.goto(stub.url);
      await expectLabeledChrome(page);
      if (width === 1440) {
        await expect(page.getByTestId("pill")).toContainText("daemon live");
        const rec = page.getByTestId("recommendation");
        const recRadius = await rec.evaluate((el) => getComputedStyle(el).borderRadius);
        expect(recRadius).toBe("18px");
        const head = page.getByRole("heading", { name: /quota advice & pacing/i });
        const headSize = await head.evaluate((el) => getComputedStyle(el).fontSize);
        expect(headSize).toBe("12.5px");
        await expect(page.getByTestId("provider-card-kimi")).toContainText("% used");
        await expect(page.getByTestId("rail")).toHaveCSS("overflow-x", "visible");
        await page.getByRole("button", { name: "Table" }).click();
        await expect(page.getByTestId("ledger-table")).toBeVisible();
        await shot(page, "dashboard-table-1440-light.png");
        await page.getByRole("button", { name: "Cards" }).click();
      } else {
        await shot(page, "dashboard-chrome-390-light.png");
      }
    } finally {
      await context.close();
    }
  }
});

test("settings tabs and advice drawer capture every operational surface", async ({ browser }) => {
  const stub = await stubFor(exampleState());
  for (const theme of THEMES) {
    const { context, page } = await themedPage(browser, theme, 1440);
    try {
      await page.goto(stub.url);
      await expect(page.getByTestId("rec-prose")).toBeVisible();
      await page.getByTestId("settings-button").click();
      const settings = page.getByTestId("settings-drawer");
      await expect(settings).toBeVisible();
      await shot(page, `settings-providers-1440-${theme}.png`);
      await page.getByRole("tab", { name: "CLI & Shell" }).click();
      await shot(page, `settings-cli-1440-${theme}.png`);
      await page.getByRole("tab", { name: "Daemon" }).click();
      await shot(page, `settings-daemon-1440-${theme}.png`);
      await page.keyboard.press("Escape");
      await expect(settings).toBeHidden();
      await page.getByTestId("view-advice").click();
      const advice = page.getByTestId("advice-drawer");
      await expect(advice).toBeVisible();
      await expect(advice).toContainText("Quota Advice");
      await expect(advice).toContainText("Recommended for next session");
      await expect(advice).toContainText("Fleet Pacing Breakdown");
      await expect(advice).toContainText("quotacap advise");
      await shot(page, `advice-drawer-1440-${theme}.png`);
      await page.keyboard.press("Escape");
      await expect(advice).toBeHidden();
    } finally {
      await context.close();
    }
  }
});

test("unknown pace shows no numeric rate or predicted waste", async ({ browser }) => {
  const stub = await stubFor(JSON.parse(unknownPaceStateSnapshotJson));
  const { context, page } = await themedPage(browser, "dark", 1440);
  try {
    await page.goto(stub.url);
    const kimi = page.getByTestId("provider-card-kimi");
    await expect(kimi).toContainText("Measuring pace");
    await expect(kimi).toContainText("—");
    await expect(page.getByTestId("dashboard-root")).not.toContainText("predicted waste");
    await shot(page, "dashboard-unknown-pace-1440-dark.png");
  } finally {
    await context.close();
  }
});

test("lanes follow server urgency", async ({ page }) => {
  const stub = await stubFor(exampleState());
  await page.goto(stub.url);
  const useMore = page.getByTestId("lane-use-more");
  await expect(useMore).toContainText("Kimi");
  await expect(useMore).toContainText("Claude");
  await expect(useMore).toContainText("Codex");
  await expect(useMore).toContainText("my-plan");
  await expect(page.getByTestId("lane-ease-off")).toHaveCount(0);
});

test("crowded resets group into a cluster popover", async ({ browser }) => {
  const stub = await stubFor(exampleState());
  for (const theme of THEMES) {
    const { context, page } = await themedPage(browser, theme, 1440);
    try {
      await page.goto(stub.url);
      const cluster = page.getByTestId("cluster-pin");
      await expect(cluster).toContainText("6 resets");
      await cluster.click();
      const popover = page.getByTestId("cluster-popover");
      await expect(popover).toBeVisible();
      await expect(popover.locator("li")).toHaveCount(6);
      await shot(page, `rail-crowded-1440-${theme}.png`);
      await popover.locator("li button").first().click();
      await expect(page.getByTestId("provider-drawer")).toBeVisible();
    } finally {
      await context.close();
    }
  }
});

test("distant resets render as overflow chips", async ({ page }) => {
  const stub = await stubFor(farResetState());
  await page.goto(stub.url);
  await expect(page.getByTestId("rail-overflow")).toContainText("+1 beyond rail");
});

test("provider drawer traps focus, closes on esc and scrim, and returns focus", async ({
  browser,
}) => {
  const stub = await stubFor(exampleState());
  for (const theme of THEMES) {
    const { context, page } = await themedPage(browser, theme, 1440);
    try {
      await page.goto(stub.url);
      const card = page.getByTestId("provider-card-kimi");
      await card.click();
      const drawer = page.getByTestId("provider-drawer");
      await expect(drawer).toBeVisible();
      await expect(drawer).toContainText(/averaged over|Window avg|Measured/);
      await shot(page, `provider-drawer-1440-${theme}.png`);
      // A reverse tab from the freshly focused dialog container stays inside.
      await page.keyboard.press("Shift+Tab");
      expect(await focusInside(page, "provider-drawer")).toBe(true);
      // Focus stays inside while tabbing.
      for (let i = 0; i < 30; i++) {
        await page.keyboard.press("Tab");
        const inside = await page.evaluate(() => {
          const d = document.querySelector('[data-testid="provider-drawer"]');
          return !!d && d.contains(document.activeElement);
        });
        expect(inside).toBe(true);
      }
      // Esc closes and returns focus to the invoking card.
      await page.keyboard.press("Escape");
      await expect(drawer).toBeHidden();
      const returned = await page.evaluate(
        () => (document.activeElement as HTMLElement | null)?.dataset?.testid ?? null
      );
      expect(returned).toBe("provider-card-kimi");
      // Scrim click closes too.
      await card.click();
      await expect(drawer).toBeVisible();
      await page.getByTestId("drawer-scrim").click({ position: { x: 10, y: 10 } });
      await expect(drawer).toBeHidden();
    } finally {
      await context.close();
    }
  }
});

test("settings drawer holds focus on an immediate reverse tab", async ({ page }) => {
  const stub = await stubFor(exampleState());
  await page.goto(stub.url);
  await page.getByTestId("settings-button").click();
  await expect(page.getByTestId("settings-drawer")).toBeVisible();
  await page.keyboard.press("Shift+Tab");
  expect(await focusInside(page, "settings-drawer")).toBe(true);
});

test("every dashboard control matches the prototype click targets", async ({ browser }) => {
  const stub = await stubFor(exampleState());
  const { context, page } = await themedPage(browser, "dark", 1440);
  try {
    await page.goto(stub.url);
    await expect(page.getByTestId("rec-prose")).toBeVisible();

    await page.getByTestId("theme-toggle").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.getByTestId("theme-toggle").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    await page.getByTestId("view-advice").click();
    const advice = page.getByTestId("advice-drawer");
    await expect(advice).toBeVisible();
    await expect(advice.getByRole("heading", { name: /quota advice & pacing/i })).toBeVisible();
    await expect(advice).toContainText("Recommended for next session");
    await expect(advice).toContainText("Use more");
    await expect(advice).toContainText("Ease off");
    await expect(advice).toContainText("$ quotacap advise");
    await shot(page, "interaction-advice-drawer-1440-dark.png");
    await page.getByRole("button", { name: "Close advice" }).click();
    await expect(advice).toBeHidden();

    await page.getByTestId("provider-card-kimi").click();
    await expect(page.getByTestId("provider-drawer")).toBeVisible();
    await expect(page.getByTestId("advice-drawer")).toHaveCount(0);
    await page.keyboard.press("Escape");

    await page.getByTestId("settings-button").click();
    const settings = page.getByTestId("settings-drawer");
    await expect(settings).toBeVisible();
    await page.getByRole("tab", { name: "Providers" }).click();
    await shot(page, "interaction-settings-providers-1440-dark.png");
    await page.getByRole("tab", { name: "CLI & Shell" }).click();
    await expect(settings).toContainText("Shell");
    await page.getByRole("tab", { name: "Daemon" }).click();
    await page.keyboard.press("Escape");
    await expect(settings).toBeHidden();

    await page.getByLabel(/Sort by/).click();
    await expect(page.getByRole("option", { name: "Recommended" })).toBeVisible();
    await page.getByRole("option", { name: "Highest Usage" }).click();
    await page.getByRole("button", { name: "Table" }).click();
    await expect(page.getByTestId("ledger-table")).toBeVisible();
    await page.getByRole("button", { name: "Cards" }).click();
    await expect(page.getByTestId("cards-grid")).toBeVisible();

    await page.getByRole("button", { name: /legend/i }).click();
    await expect(page.getByRole("dialog", { name: "Pacing legend" })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("the projected-unused hatch paints a gradient the browser accepts", async ({ page }) => {
  const stub = await stubFor(exampleState());
  await page.goto(stub.url);
  // A CSS variable with an alpha suffix parses to nothing, so the browser
  // would report background-image: none and the hatch would never show.
  const painted = await page.evaluate((gradient) => {
    const probe = document.createElement("div");
    probe.style.background = gradient;
    document.body.append(probe);
    const image = getComputedStyle(probe).backgroundImage;
    probe.remove();
    return image;
  }, hatchGradient("Behind pace"));
  expect(painted).not.toBe("none");
  expect(painted).toContain("gradient");
  for (const hatch of await page.getByTestId("pace-hatch").all()) {
    await expect(hatch).toHaveCSS("background-image", /gradient/);
  }
});

test("settings lists adapters only and has no ingest form", async ({
  browser,
}) => {
  const stub = await stubFor(exampleState());
  const { context, page } = await themedPage(browser, "light", 1440);
  try {
    await page.goto(stub.url);
    await page.getByTestId("settings-button").click();
    const drawer = page.getByTestId("settings-drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText("Kimi Code")).toBeVisible();
    await expect(drawer.getByText("manual", { exact: true })).toHaveCount(0);
    await expect(drawer.getByText("Manual Quota Ingest")).toHaveCount(0);
    await expect(page.getByLabel("Provider id for manual ingest")).toHaveCount(0);
    await shot(page, "settings-drawer-1440-light.png");
  } finally {
    await context.close();
  }
  const dark = await themedPage(browser, "dark", 1440);
  try {
    await dark.page.goto(stub.url);
    await dark.page.getByTestId("settings-button").click();
    await expect(dark.page.getByTestId("settings-drawer")).toBeVisible();
    await shot(dark.page, "settings-drawer-1440-dark.png");
  } finally {
    await dark.context.close();
  }
});

test("keyboard-only traversal reaches rail pins, sort, density, and drawers", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const stub = await stubFor(spreadResetState());
  await page.goto(stub.url);
  // Rail pin opens the drawer from the keyboard.
  const pin = page.getByTestId("pin").first();
  await pin.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("provider-drawer")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("provider-drawer")).toBeHidden();
  // Card opens the drawer from the keyboard.
  await page.getByTestId("provider-card-kimi").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("provider-drawer")).toBeVisible();
  await page.keyboard.press("Escape");
  // Sort changes order from the keyboard via the custom SortDropdown.
  await expect(page.getByTestId("cards-grid").locator("article").first()).toHaveAttribute(
    "data-testid",
    "provider-card-my-plan"
  );
  await page.getByLabel(/Sort/).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("option", { name: "Highest Usage" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("cards-grid").locator("article").first()).toHaveAttribute(
    "data-testid",
    "provider-card-agy:3p"
  );
  // Density and legend work from the keyboard.
  await page.getByRole("button", { name: "Table" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("ledger-table")).toBeVisible();
  await page.getByRole("button", { name: /legend/i }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Pacing legend" })).toBeVisible();
});

test("reduced motion disables transitions", async ({ browser }) => {
  const stub = await stubFor(exampleState());
  const context = await browser.newContext({ reducedMotion: "reduce" });
  try {
    const page = await context.newPage();
    await page.goto(stub.url);
    await expect(page.getByTestId("rec-prose")).toBeVisible();
    const reduced = await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
    expect(reduced).toBe(true);
    const duration = await page.evaluate(() => getComputedStyle(document.body).transitionDuration);
    expect(duration).toBe("0s");
  } finally {
    await context.close();
  }
});

test("every graphic carries its label", async ({ page }) => {
  const stub = await stubFor(spreadResetState());
  await page.goto(stub.url);
  await expect(page.getByTestId("rail")).toHaveAttribute("aria-label", /next 7 days/);
  const bars = page.getByTestId("pace-bar");
  expect(await bars.count()).toBeGreaterThan(0);
  for (let i = 0; i < (await bars.count()); i++) {
    await expect(bars.nth(i)).toHaveAttribute("aria-label", /used/);
  }
  const pins = page.getByTestId("pin");
  expect(await pins.count()).toBeGreaterThan(0);
  for (let i = 0; i < (await pins.count()); i++) {
    await expect(pins.nth(i)).toHaveAttribute("aria-label", /resets/);
  }
  await expect(page.locator(".pin-label.pace-behind").first()).toBeVisible();
  await expect(page.getByTestId("rail")).toHaveCSS("overflow-x", "visible");
});

test("fault banner per excluded provider carries last-read age", async ({ page }) => {
  const stub = await stubFor(exampleState());
  await page.goto(stub.url);
  const banners = page.getByTestId("fault-banner");
  await expect(banners).toHaveCount(2);
  await expect(banners.filter({ hasText: "Antigravity 3P" })).toContainText("Last read 3h ago");
  await expect(banners.filter({ hasText: "Grok" })).toContainText("invalid reading");
  await expect(banners.filter({ hasText: "manual" })).toHaveCount(0);
});

test("failed refresh preserves prior readings with age", async ({ page }) => {
  const stub = await stubFor(exampleState());
  await page.goto(stub.url);
  await expect(page.getByTestId("rec-prose")).toContainText(recWaste(exampleState()));
  stub.setRefresh({ status: 500, body: { error: "poll exploded" } });
  await page.getByTestId("refresh-button").click();
  const stale = page.getByTestId("state-stale-error");
  await expect(stale).toContainText("poll exploded");
  await expect(stale).toContainText(/read .* ago/);
  await expect(page.getByTestId("rec-prose")).toContainText(recWaste(exampleState()));
});

test("refresh surfaces server cooldown info verbatim", async ({ page }) => {
  const stub = await stubFor(exampleState());
  await page.goto(stub.url);
  stub.setRefresh({ body: { message: "cooling down: retry in 40s" } });
  await page.getByTestId("refresh-button").click();
  await expect(page.getByTestId("refresh-notice")).toContainText("cooling down: retry in 40s");
});

test("first run routes to setup and completes to the dashboard", async ({ browser }) => {
  const stub = await stubFor(firstRunState());
  const { context, page } = await themedPage(browser, "light", 1440);
  try {
    await page.goto(`${stub.url}/`);
    await expect(page).toHaveURL(/\/setup$/);
    await expect(page.getByTestId("setup-step-1")).toBeVisible();
    await expect(page.getByTestId("setup-step-1")).toContainText("Sign in first");
    await shot(page, "setup-1-1440-light.png");
    await page.getByRole("button", { name: "Continue to review" }).click();
    await expect(page.getByTestId("setup-step-2")).toBeVisible();
    await shot(page, "setup-2-1440-light.png");
    await page.getByRole("button", { name: "Continue to first poll" }).click();
    await expect(page.getByTestId("setup-step-3")).toBeVisible();
    await expect(page.getByTestId("setup-step-3")).toContainText("Sample data");
    stub.setRefresh({ nextState: exampleState() });
    await page.getByTestId("setup-poll-button").click();
    await expect(page).toHaveURL(`${stub.url}/`);
    await expect(page.getByTestId("rec-prose")).toContainText(recWaste(exampleState()));
  } finally {
    await context.close();
  }
  // Fresh first-run stub: the main flow above mutated the shared state.
  const narrowStub = await stubFor(firstRunState());
  const narrow = await themedPage(browser, "dark", 390);
  try {
    await narrow.page.goto(`${narrowStub.url}/setup`);
    await expect(narrow.page.getByTestId("setup-step-1")).toBeVisible();
    await expectNoPageOverflow(narrow.page);
    await shot(narrow.page, "setup-1-390-dark.png");
  } finally {
    await narrow.context.close();
  }
});

test("setup step 3 renders the payoff preview", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const stub = await stubFor(firstRunState());
  await page.goto(`${stub.url}/setup`);
  await page.getByRole("button", { name: "Continue to review" }).click();
  await page.getByRole("button", { name: "Continue to first poll" }).click();
  await expect(page.getByTestId("setup-step-3")).toBeVisible();
  await shot(page, "setup-3-1440-light.png");
});

test("error states render from server fields", async ({ browser }) => {
  // Service unavailable: the state endpoint never answers.
  {
    const stub = await stubFor(exampleState());
    const { context, page } = await themedPage(browser, "dark", 1440);
    try {
      await page.route("**/api/state", (route) => route.abort());
      await page.goto(stub.url);
      const panel = page.getByTestId("state-unavailable");
      await expect(panel).toBeVisible();
      await expect(panel).toContainText("/api/state");
      await shot(page, "states-unavailable-1440-dark.png");
      await page.unroute("**/api/state");
      await panel.getByRole("button", { name: "Retry" }).click();
      await expect(page.getByTestId("rec-prose")).toContainText(recWaste(exampleState()));
    } finally {
      await context.close();
    }
  }
  // HTTP error: status code plus the server message.
  {
    const stub = await stubFor(exampleState());
    const { context, page } = await themedPage(browser, "dark", 1440);
    try {
      await page.route("**/api/state", (route) =>
        route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "state exploded" }),
        })
      );
      await page.goto(stub.url);
      const panel = page.getByTestId("state-http-error");
      await expect(panel).toContainText("HTTP 500");
      await expect(panel).toContainText("state exploded");
      await shot(page, "states-http-error-1440-dark.png");
    } finally {
      await context.close();
    }
  }
  // Initial loading: skeletons, not blank.
  {
    const stub = await stubFor(exampleState(), { stateDelayMs: 3000 });
    const { context, page } = await themedPage(browser, "dark", 1440);
    try {
      await page.goto(stub.url);
      await expect(page.getByTestId("state-loading")).toBeVisible();
      await shot(page, "states-loading-1440-dark.png");
      await expect(page.getByTestId("rec-prose")).toContainText(recWaste(exampleState()));
    } finally {
      await context.close();
    }
  }
  // Fixture variants and the balanced state.
  const variants: Array<[string, unknown, RegExp]> = [
    ["stale", JSON.parse(staleStateSnapshotJson), /Last read 3h ago/],
    ["reset-passed", JSON.parse(resetPassedStateSnapshotJson), /awaiting fresh window/],
    ["balanced", balancedState(), /No subscription needs priority/],
  ];
  for (const [name, state, marker] of variants) {
    const stub = await stubFor(state);
    const { context, page } = await themedPage(browser, "dark", 1440);
    try {
      await page.goto(stub.url);
      await expect(page.getByTestId("dashboard-root")).toContainText(marker);
      await shot(page, `dashboard-${name}-1440-dark.png`);
    } finally {
      await context.close();
    }
  }
  // Estimated resets carry (est.) on every reset rendering.
  {
    const stub = await stubFor(exampleState());
    const { context, page } = await themedPage(browser, "dark", 1440);
    try {
      await page.goto(stub.url);
      await expect(page.getByTestId("provider-card-codex")).toContainText("(est.)");
    } finally {
      await context.close();
    }
  }
});
