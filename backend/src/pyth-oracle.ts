import { config } from "./config.js";
import { ApiError } from "./http.js";

export type OraclePrice = {
  feedId: string;
  priceAtomic: bigint;
  publishTime: Date;
};

type HermesResponse = {
  parsed?: Array<{
    id?: string;
    price?: { price?: string; expo?: number; publish_time?: number };
  }>;
};

export async function latestPythPrice(feedIdInput: string): Promise<OraclePrice> {
  const feedId = feedIdInput.replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(feedId)) {
    throw new ApiError(503, "oracle_feed_misconfigured", "The configured Pyth feed ID is invalid.");
  }
  if (!config.PYTH_API_KEY) {
    throw new ApiError(503, "oracle_unavailable", "PYTH_API_KEY is required to run Proving Ground.");
  }

  const url = new URL(`${config.PYTH_HERMES_URL.replace(/\/$/, "")}/v2/updates/price/latest`);
  url.searchParams.append("ids[]", feedId);
  url.searchParams.set("parsed", "true");
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { authorization: `Bearer ${config.PYTH_API_KEY}` },
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new ApiError(503, "oracle_unavailable", "The configured price oracle could not be reached.");
  }
  if (!response.ok) throw new ApiError(503, "oracle_unavailable", "The configured price oracle did not return a price.");

  let payload: HermesResponse;
  try { payload = await response.json() as HermesResponse; }
  catch { throw new ApiError(503, "oracle_response_invalid", "The price oracle returned invalid data."); }
  const feed = payload.parsed?.find((item) => item.id?.replace(/^0x/i, "").toLowerCase() === feedId);
  const value = feed?.price;
  if (!value?.price || value.expo === undefined || value.publish_time === undefined
    || !Number.isInteger(value.expo) || value.expo < -18 || value.expo > 18
    || !/^-?\d{1,30}$/.test(value.price) || !Number.isSafeInteger(value.publish_time)) {
    throw new ApiError(503, "oracle_response_invalid", "The price oracle response is missing the configured feed price.");
  }
  const publishTime = new Date(value.publish_time * 1000);
  const ageMs = Date.now() - publishTime.getTime();
  if (!Number.isFinite(publishTime.getTime()) || ageMs > 120_000 || ageMs < -5_000) {
    throw new ApiError(503, "oracle_price_stale", "The latest oracle price is stale or from the future.");
  }
  let priceAtomic: bigint;
  try {
    const exponent = value.expo + 6;
    priceAtomic = exponent >= 0
      ? BigInt(value.price) * 10n ** BigInt(exponent)
      : BigInt(value.price) / 10n ** BigInt(-exponent);
  } catch {
    throw new ApiError(503, "oracle_response_invalid", "The price oracle returned an invalid numeric price.");
  }
  if (priceAtomic <= 0n) throw new ApiError(503, "oracle_response_invalid", "The price oracle returned a nonpositive price.");
  return { feedId, priceAtomic, publishTime };
}
