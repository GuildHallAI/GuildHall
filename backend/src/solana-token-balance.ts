type ParsedTokenBalance = {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
};

/** Calculates the net change for one owner, including token accounts closed in the same transaction. */
export function tokenOwnerBalanceDelta(
  preBalances: readonly ParsedTokenBalance[],
  postBalances: readonly ParsedTokenBalance[],
  mint: string,
  owner: string,
) {
  const accounts = new Set<number>();
  for (const balance of preBalances) {
    if (balance.mint === mint && balance.owner === owner) accounts.add(balance.accountIndex);
  }
  for (const balance of postBalances) {
    if (balance.mint === mint && balance.owner === owner) accounts.add(balance.accountIndex);
  }
  let delta = 0n;
  for (const accountIndex of accounts) {
    const before = preBalances.find((balance) => balance.accountIndex === accountIndex && balance.mint === mint);
    const after = postBalances.find((balance) => balance.accountIndex === accountIndex && balance.mint === mint);
    delta += BigInt(after?.uiTokenAmount.amount ?? "0") - BigInt(before?.uiTokenAmount.amount ?? "0");
  }
  return delta;
}
