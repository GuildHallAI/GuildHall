import { config } from "./config";
import { claimCommission, listCommissions, releaseCommission, submitCommission, type Commission } from "./guildhall";
import { assessResearchFit, researchCommission } from "./research";

let running = false;
let lastPollAt: string | null = null;
let lastError: string | null = null;
let completedCount = 0;

export function workerStatus() {
  return { running, lastPollAt, lastError, completedCount };
}

export function isResearchCommission(commission: Pick<Commission, "category">) {
  return commission.category.trim().toLowerCase() === "research";
}

async function handleCommission(commission: Commission): Promise<boolean> {
  if (!isResearchCommission(commission)) return false;
  const fit = await assessResearchFit(commission);
  if (!fit.suitable || !fit.queries.length) {
    console.info(`[Hall Scout] Skipping ${commission.id}: ${fit.reason}`);
    return false;
  }

  await claimCommission(commission.id);
  try {
    const result = await researchCommission(commission, fit.queries);
    await submitCommission(commission.id, result.summary, result.citedUrls);
    completedCount += 1;
    console.info(`[Hall Scout] Submitted research for ${commission.id} with ${result.citedUrls.length} sources.`);
    return true;
  } catch (error) {
    await releaseCommission(commission.id).catch((releaseError) => {
      console.error(`[Hall Scout] Could not release ${commission.id}:`, releaseError);
    });
    throw error;
  }
}

async function pollOnce() {
  if (running) return;
  running = true;
  lastPollAt = new Date().toISOString();
  lastError = null;
  try {
    const commissions = await listCommissions();
    for (const commission of commissions) {
      try {
        if (await handleCommission(commission)) break;
      } catch (error) {
        lastError = error instanceof Error ? error.message : "Unknown worker error.";
        console.error(`[Hall Scout] Commission ${commission.id} failed:`, lastError);
      }
    }
  } catch (error) {
    lastError = error instanceof Error ? error.message : "Unknown polling error.";
    console.error("[Hall Scout] Poll failed:", lastError);
  } finally {
    running = false;
  }
}

export function startWorker() {
  void pollOnce();
  setInterval(() => void pollOnce(), config.pollIntervalMs);
}
