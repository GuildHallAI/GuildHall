import { config } from "./config";
import { claimCommission, discardCommissionImage, listCommissions, releaseCommission, submitCommission, uploadCommissionImage, type Commission } from "./guildhall";
import { assessResearchFit, researchCommission } from "./research";
import { assessImageBrief, generateCommissionImage, isImageCommission } from "./image-agent";

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

async function handleCommission(commission: Commission, token: string): Promise<boolean> {
  if (!isResearchCommission(commission) && !isImageCommission(commission)) return false;
  if (isImageCommission(commission) && !config.openRouterApiKey) {
    console.info(`[Hallwright] Skipping ${commission.id}: OPENROUTER_API_KEY is not configured.`);
    return false;
  }
  const researchFit = isResearchCommission(commission) ? await assessResearchFit(commission) : null;
  const imageBrief = isImageCommission(commission) ? await assessImageBrief(commission) : null;
  if (researchFit && (!researchFit.suitable || !researchFit.queries.length)) {
    console.info(`[Hall Scout] Skipping ${commission.id}: ${researchFit.reason}`);
    return false;
  }
  if (imageBrief && (!imageBrief.suitable || !imageBrief.prompt.trim())) {
    console.info(`[Hallwright] Skipping ${commission.id}: ${imageBrief.reason}`);
    return false;
  }

  await claimCommission(commission.id, token);
  let stagedAssetId: string | undefined;
  try {
    if (researchFit) {
      const result = await researchCommission(commission, researchFit.queries);
      await submitCommission(commission.id, token, result.summary,
        result.citedUrls.map((url, index) => ({ kind: "url" as const, label: `Research source ${index + 1}`, value: url })));
      console.info(`[Hall Scout] Submitted research for ${commission.id} with ${result.citedUrls.length} sources.`);
    } else if (imageBrief) {
      const generated = await generateCommissionImage(imageBrief.prompt);
      const asset = await uploadCommissionImage(commission.id, token, generated.bytes, generated.mediaType);
      stagedAssetId = asset.id;
      await submitCommission(commission.id, token, imageBrief.summary, [
        { kind: "image", label: imageBrief.altText || "Hallwright generated image", value: asset.id },
      ]);
      console.info(`[Hallwright] Submitted image asset ${asset.id} for ${commission.id}.`);
    }
    completedCount += 1;
    return true;
  } catch (error) {
    if (stagedAssetId) {
      await discardCommissionImage(commission.id, stagedAssetId, token).catch((cleanupError) => {
        console.error(`[GuildHall agent] Could not clean up staged image ${stagedAssetId}:`, cleanupError);
      });
    }
    await releaseCommission(commission.id, token).catch((releaseError) => {
      console.error(`[GuildHall agent] Could not release ${commission.id}:`, releaseError);
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
    for (const [index, token] of config.runtimeTokens.entries()) {
      try {
        const commissions = await listCommissions(token);
        for (const commission of commissions) {
          try {
            if (await handleCommission(commission, token)) break;
          } catch (error) {
            lastError = error instanceof Error ? error.message : "Unknown worker error.";
            const agent = isImageCommission(commission) ? "Hallwright" : "Hall Scout";
            console.error(`[${agent}] Commission ${commission.id} failed:`, lastError);
          }
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : "Unknown polling error.";
        console.error(`[GuildHall agent runtime] Poll failed for configured credential ${index + 1}:`, lastError);
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
