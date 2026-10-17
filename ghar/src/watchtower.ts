import { randomUUID } from "node:crypto";
import { claimCommission, listWatchAlerts, submitCommission, submitWatchAlert, type Commission, type WatchAlert } from "./guildhall";

const INFO_URL = "https://api.hyperliquid.xyz/info";
const VENUE = "hyperliquid";
const marketStates = new Map<string, WatchObservationState>();
const snapshots = new Map<string, { snapshot: MarketSnapshot; expiresAt: number }>();
const fundingMedians = new Map<string, { value: number; expiresAt: number }>();

export type WatchTrigger =
  | { type: "deviation"; thresholdPercent: number; persistenceSeconds: number }
  | { type: "thin_ref"; minimumDepthUsd: number; minimumOpenInterestUsd: number }
  | { type: "stale"; staleMinutes: number; referenceMovePercent: number }
  | { type: "funding_spike"; baselineMultiplier: number };

type WatchCommission = Commission & {
  watchTerms: { venue: string; market: string; monitoringHours: number; trigger: WatchTrigger };
  fundedAt?: string | null;
};

export type WatchObservationState = {
  conditionSince?: number;
  conditionReported?: boolean;
  lastAlertedAt?: number;
  oraclePrice?: number;
  oracleUnchangedSince?: number;
  markAtOracleChange?: number;
  startedAt: number;
  lastObservedAt: number;
};

type MarketSnapshot = {
  coin: string;
  mark: number;
  oracle: number;
  funding: number;
  openInterestUsd: number;
  topBookDepthUsd: number;
  observedAt: string;
};

export type WatchSnapshot = MarketSnapshot;

type AssetContext = { markPx?: string; oraclePx?: string; funding?: string; openInterest?: string };
type Level = { px?: string; sz?: string };

async function info<T>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch(INFO_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Hyperliquid market data returned ${response.status}.`);
  return response.json() as Promise<T>;
}

function finite(value: unknown, label: string) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Hyperliquid returned an invalid ${label}.`);
  return parsed;
}

export function coinFor(market: string) {
  return market.trim().toUpperCase().replace(/\s+/g, "").replace(/[-_/]?(PERP|USDT|USDC)$/, "");
}

function supportedCommission(commission: Commission): commission is WatchCommission {
  const venue = commission.watchTerms?.venue.trim().toLowerCase().replace(/[^a-z]/g, "");
  return commission.workType === "watch" && Boolean(commission.watchTerms)
    && [VENUE, "hyperliquidperps", "hyperliquidperpetuals"].includes(venue ?? "")
    && Boolean(coinFor(commission.watchTerms!.market));
}

export function isWatchCommission(commission: Pick<Commission, "workType" | "category">) {
  return commission.workType === "watch" && commission.category.trim().toLowerCase() === "watch";
}

async function marketSnapshot(commission: WatchCommission): Promise<MarketSnapshot> {
  const coin = coinFor(commission.watchTerms.market);
  const cached = snapshots.get(coin);
  if (cached && cached.expiresAt > Date.now()) return cached.snapshot;

  const [metaAndContexts, book] = await Promise.all([
    info<[ { universe: Array<{ name: string }> }, AssetContext[] ]>({ type: "metaAndAssetCtxs" }),
    info<{ levels: [Level[], Level[]] }>({ type: "l2Book", coin }),
  ]);
  const index = metaAndContexts[0].universe.findIndex((asset) => asset.name.toUpperCase() === coin);
  if (index < 0) throw new Error(`Market ${commission.watchTerms.market} is not a supported Hyperliquid perpetual.`);
  const context = metaAndContexts[1][index];
  if (!context) throw new Error(`Hyperliquid returned no market context for ${coin}.`);
  const mark = finite(context.markPx, "mark price");
  const oracle = finite(context.oraclePx, "oracle price");
  const funding = Number(context.funding);
  if (!Number.isFinite(funding)) throw new Error("Hyperliquid returned an invalid funding rate.");
  const openInterest = finite(context.openInterest, "open interest") * mark;
  const levels = book.levels ?? [[], []];
  const topBookDepthUsd = levels.flatMap((side) => side.slice(0, 1)).reduce((total, level) => {
    const price = Number(level.px);
    const size = Number(level.sz);
    return Number.isFinite(price) && Number.isFinite(size) && price > 0 && size > 0 ? total + price * size : total;
  }, 0);
  const snapshot = { coin, mark, oracle, funding, openInterestUsd: openInterest, topBookDepthUsd, observedAt: new Date().toISOString() };
  snapshots.set(coin, { snapshot, expiresAt: Date.now() + 10_000 });
  return snapshot;
}

async function thirtyDayMedianAbsFunding(coin: string) {
  const cached = fundingMedians.get(coin);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const now = Date.now();
  const start = now - 30 * 24 * 60 * 60 * 1000;
  let cursor = start;
  const rates: number[] = [];
  while (cursor < now) {
    const page = await info<Array<{ time: number; fundingRate: string }>>({
      type: "fundingHistory", coin, startTime: cursor, endTime: now,
    });
    if (!page.length) break;
    for (const row of page) {
      const rate = Number(row.fundingRate);
      if (Number.isFinite(rate) && row.time >= start && row.time <= now) rates.push(Math.abs(rate));
    }
    const lastTime = page[page.length - 1]!.time;
    if (page.length < 500 || lastTime < cursor || lastTime >= now) break;
    cursor = lastTime + 1;
  }
  rates.sort((a, b) => a - b);
  if (!rates.length) throw new Error(`No 30-day funding history is available for ${coin}.`);
  const middle = Math.floor(rates.length / 2);
  const median = rates.length % 2 ? rates[middle]! : (rates[middle - 1]! + rates[middle]!) / 2;
  if (median <= 0) throw new Error(`The 30-day funding baseline for ${coin} is zero and cannot support a relative threshold.`);
  fundingMedians.set(coin, { value: median, expiresAt: now + 6 * 60 * 60 * 1000 });
  return median;
}

function pctDifference(value: number, reference: number) {
  return Math.abs(value - reference) / Math.abs(reference) * 100;
}

function alertFor(commission: WatchCommission, snapshot: MarketSnapshot, observedValue: number, referenceValue: number, notes: string): WatchAlert {
  return {
    idempotencyKey: randomUUID(),
    alertType: commission.watchTerms.trigger.type,
    observedAt: snapshot.observedAt,
    observedValue: String(observedValue),
    referenceValue: String(referenceValue),
    evidenceUrl: `https://app.hyperliquid.xyz/trade/${encodeURIComponent(snapshot.coin)}`,
    notes: `${notes} Source: Hyperliquid public market data.`,
  };
}

export function evaluateWatchCondition(trigger: WatchTrigger, snapshot: WatchSnapshot, state: WatchObservationState, now: number, fundingBaseline?: number) {
  state.lastObservedAt = now;
  const signal = (observedValue: number, referenceValue: number, notes: string) => {
    if (state.conditionReported || (state.lastAlertedAt !== undefined && now - state.lastAlertedAt < 5 * 60_000)) return null;
    state.conditionReported = true;
    state.lastAlertedAt = now;
    return { observedValue, referenceValue, notes };
  };
  if (trigger.type === "deviation") {
    const deviation = pctDifference(snapshot.mark, snapshot.oracle);
    if (deviation < trigger.thresholdPercent) {
      state.conditionSince = undefined;
      state.conditionReported = false;
      return null;
    }
    state.conditionSince ??= now;
    if (now - state.conditionSince < trigger.persistenceSeconds * 1000) return null;
    return signal(snapshot.mark, snapshot.oracle,
      `Mark/oracle deviation reached ${deviation.toFixed(4)}%, above ${trigger.thresholdPercent}% for at least ${trigger.persistenceSeconds} seconds.`);
  }

  if (trigger.type === "thin_ref") {
    if (snapshot.topBookDepthUsd >= trigger.minimumDepthUsd || snapshot.openInterestUsd < trigger.minimumOpenInterestUsd) {
      state.conditionReported = false;
      return null;
    }
    return signal(snapshot.topBookDepthUsd, snapshot.openInterestUsd,
      `Visible top-book depth was below $${trigger.minimumDepthUsd} while open interest was above $${trigger.minimumOpenInterestUsd}.`);
  }

  if (trigger.type === "stale") {
    if (state.oraclePrice === undefined || Math.abs(state.oraclePrice - snapshot.oracle) > Math.max(1e-12, Math.abs(snapshot.oracle) * 1e-12)) {
      state.oraclePrice = snapshot.oracle;
      state.oracleUnchangedSince = now;
      state.markAtOracleChange = snapshot.mark;
      state.conditionReported = false;
      return null;
    }
    const staleFor = now - (state.oracleUnchangedSince ?? now);
    const movement = pctDifference(snapshot.mark, state.markAtOracleChange ?? snapshot.mark);
    if (staleFor < trigger.staleMinutes * 60_000 || movement < trigger.referenceMovePercent) {
      if (movement < trigger.referenceMovePercent) state.conditionReported = false;
      return null;
    }
    return signal(snapshot.mark, snapshot.oracle,
      `Oracle value was unchanged for ${(staleFor / 60_000).toFixed(1)} minutes while mark moved ${movement.toFixed(4)}%.`);
  }

  const baseline = fundingBaseline;
  if (!baseline || baseline <= 0) return null;
  const multiple = Math.abs(snapshot.funding) / baseline;
  if (multiple < trigger.baselineMultiplier) {
    state.conditionReported = false;
    return null;
  }
  return signal(snapshot.funding, baseline,
    `Absolute funding was ${multiple.toFixed(2)}x the 30-day median absolute funding, above the configured ${trigger.baselineMultiplier}x threshold.`);
}

async function evaluate(commission: WatchCommission, snapshot: MarketSnapshot, knownAlerts: Array<Pick<WatchAlert, "alertType">>) {
  if (knownAlerts.length >= 500) return null;
  const now = Date.now();
  let state = marketStates.get(commission.id);
  if (!state) {
    state = { startedAt: now, lastObservedAt: now,
      conditionReported: knownAlerts.some((alert) => alert.alertType === commission.watchTerms.trigger.type) };
    marketStates.set(commission.id, state);
  }
  const baseline = commission.watchTerms.trigger.type === "funding_spike"
    ? await thirtyDayMedianAbsFunding(snapshot.coin)
    : undefined;
  const signal = evaluateWatchCondition(commission.watchTerms.trigger, snapshot, state, now, baseline);
  return signal ? alertFor(commission, snapshot, signal.observedValue, signal.referenceValue, signal.notes) : null;
}

export async function claimAndMonitorWatchCommission(commission: Commission, token: string) {
  if (!supportedCommission(commission)) return false;
  const fundedAt = commission.fundedAt ? new Date(commission.fundedAt).getTime() : Date.now();
  const windowEnd = Math.min(
    fundedAt + commission.watchTerms.monitoringHours * 60 * 60 * 1000,
    new Date(commission.deadlineAt).getTime(),
  );
  if (Date.now() >= windowEnd) {
    console.info(`[Hall Watchtower] Skipping ${commission.id}: its funded monitoring window has ended.`);
    return false;
  }
  // Validate the venue and symbol before accepting work, so unsupported markets remain available.
  let snapshot: MarketSnapshot;
  try {
    snapshot = await marketSnapshot(commission);
  } catch (error) {
    console.info(`[Hall Watchtower] Skipping ${commission.id}: ${error instanceof Error ? error.message : "Unsupported market."}`);
    return false;
  }
  await claimCommission(commission.id, token);
  await monitorAssignedWatchCommission(commission, token, snapshot);
  return true;
}

export async function monitorAssignedWatchCommission(commission: Commission, token: string, currentSnapshot?: MarketSnapshot) {
  if (!supportedCommission(commission)) return;
  const knownAlerts = await listWatchAlerts(commission.id, token);
  const now = Date.now();
  const fundedAt = commission.fundedAt ? new Date(commission.fundedAt).getTime() : now;
  const deadline = new Date(commission.deadlineAt).getTime();
  const windowEnd = Math.min(fundedAt + commission.watchTerms.monitoringHours * 60 * 60 * 1000, deadline);
  const state = marketStates.get(commission.id);
  let finalAlerts = knownAlerts;
  let snapshotCoin = coinFor(commission.watchTerms.market);
  if (now < windowEnd) {
    const snapshot = currentSnapshot ?? await marketSnapshot(commission);
    snapshotCoin = snapshot.coin;
    const alert = await evaluate(commission, snapshot, knownAlerts);
    if (alert) {
      await submitWatchAlert(commission.id, token, alert);
      finalAlerts = [...knownAlerts, alert];
      console.info(`[Hall Watchtower] Reported ${alert.alertType} for ${commission.watchTerms.market} on commission ${commission.id}.`);
    }
    return;
  }

  const coverageStart = new Date(state?.startedAt ?? now).toISOString();
  const coverageEnd = new Date(state?.lastObservedAt ?? now).toISOString();
  const summary = state
    ? finalAlerts.length
      ? `Hall Watchtower observed ${commission.watchTerms.market} on Hyperliquid from ${coverageStart} through ${coverageEnd} and reported ${finalAlerts.length} configured alert(s). This report covers observations made while this runtime was active; review the alert evidence and timestamps.`
      : `Hall Watchtower observed ${commission.watchTerms.market} on Hyperliquid from ${coverageStart} through ${coverageEnd} and recorded no configured alert during that observed coverage. This does not establish continuous coverage outside those timestamps.`
    : finalAlerts.length
      ? `Hall Watchtower has ${finalAlerts.length} alert(s) recorded for ${commission.watchTerms.market} on Hyperliquid. This runtime has no local observation history for the full window; review the submitted alert timestamps and evidence.`
      : `No alert was recorded for ${commission.watchTerms.market}. This runtime has no local observation history for the funded monitoring window, so it cannot confirm continuous monitoring or assert that the condition did not occur.`;
  await submitCommission(commission.id, token, summary, [
    { kind: "url", label: "Hyperliquid market data", value: `https://app.hyperliquid.xyz/trade/${encodeURIComponent(snapshotCoin)}` },
    { kind: "text", label: "Monitoring coverage", value: state
      ? `${coverageStart} to ${coverageEnd}. ${finalAlerts.length} alert(s) recorded.`
      : `No local observation timestamps are available. ${finalAlerts.length} alert(s) recorded.` },
  ]);
  marketStates.delete(commission.id);
  console.info(`[Hall Watchtower] Submitted final report for commission ${commission.id}.`);
}

export async function processWatchCommission(commission: Commission, token: string, profileName: string) {
  if (profileName !== "hall-watchtower" || !isWatchCommission(commission)) return false;
  if (!supportedCommission(commission)) {
    console.info(`[Hall Watchtower] Skipping ${commission.id}: only Hyperliquid perpetual markets are supported currently.`);
    return false;
  }
  return claimAndMonitorWatchCommission(commission, token);
}

export async function resumeAssignedWatchCommissions(token: string, commissions: Commission[]) {
  for (const commission of commissions) {
    if (!supportedCommission(commission)) continue;
    try {
      await monitorAssignedWatchCommission(commission, token);
    } catch (error) {
      console.error(`[Hall Watchtower] Monitoring ${commission.id} failed:`, error instanceof Error ? error.message : error);
    }
  }
}

