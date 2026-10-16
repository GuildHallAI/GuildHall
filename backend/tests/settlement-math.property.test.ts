import { describe, expect, it } from "bun:test";
import {
  allocateCrewAmount,
  commissionDistribution,
  crewTransferPlan,
  type CrewShare,
} from "../src/escrow-settlement.js";

function generator(seed: number) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

const next = generator(0x4755494c);
const MAX_U64 = (1n << 64n) - 1n;
const wallet = "11111111111111111111111111111111";

function randomShares(): CrewShare[] {
  const count = 1 + (next() % 5);
  let remaining = 10_000;
  return Array.from({ length: count }, (_, index) => {
    const slotsAfter = count - index - 1;
    const minimumForThis = 1;
    const maximumForThis = remaining - slotsAfter;
    const shareBps = slotsAfter === 0
      ? remaining
      : minimumForThis + (next() % (maximumForThis - minimumForThis + 1));
    remaining -= shareBps;
    return {
      userId: `member-${index}`,
      walletAddress: wallet,
      shareBps,
      payoutOrder: index + 1,
      charterBuybackWallet: null,
    };
  });
}

describe("commission payout accounting properties", () => {
  it("conserves every atomic unit across fees, provider and client for 100,000 cases", () => {
    for (let index = 0; index < 100_000; index += 1) {
      const gross = 1n + (BigInt(next()) * BigInt(next()) % MAX_U64);
      const feeBps = BigInt(next() % 10_001);
      const split = (next() & 1) === 1;
      const result = commissionDistribution(gross.toString(), split, feeBps);
      const values = Object.values(result.distribution).map(BigInt);
      const total = values.reduce((sum, amount) => sum + amount, 0n);

      expect(total).toBe(gross);
      expect(BigInt(result.feeAtomic)).toBe(gross * feeBps / 10_000n);
      expect(values.every((amount) => amount >= 0n)).toBe(true);
    }
  });

  it("conserves crew allocations and transfer plans for 100,000 valid share sets", () => {
    const recipients = [wallet, wallet, wallet];
    for (let index = 0; index < 100_000; index += 1) {
      const gross = 1n + (BigInt(next()) * BigInt(next()) % MAX_U64);
      const shares = randomShares();
      const split = (next() & 1) === 1;
      const { feeAtomic, distribution } = commissionDistribution(gross.toString(), split);
      const provider = BigInt(distribution.provider!);
      const allocation = allocateCrewAmount(provider.toString(), shares);
      expect(allocation.reduce((sum, item) => sum + BigInt(item.amountAtomic), 0n)).toBe(provider);

      const plan = crewTransferPlan(
        distribution.provider!,
        distribution.client,
        wallet,
        shares,
        recipients,
        distribution,
      );
      const planned = plan.reduce((sum, item) => sum + BigInt(item.amountAtomic), 0n);
      expect(planned).toBe(gross);
      expect(BigInt(feeAtomic)).toBe(BigInt(distribution.workers!) + BigInt(distribution.treasury!)
        + BigInt(distribution.stakers!) + BigInt(distribution.burn!));
    }
  });
});
