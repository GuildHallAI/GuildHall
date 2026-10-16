export const GHALL_CA = "ABmp7kvhMFXEUvjq9cybBPPbrju8uv8GTQPCDbvLpump";

export function TokenAddress({ compact = false }: { compact?: boolean }) {
  return <a
    className={`token-address${compact ? " token-address-compact" : ""}`}
    href={`https://solscan.io/token/${GHALL_CA}`}
    target="_blank"
    rel="noopener noreferrer"
    aria-label={`View $GUILD token on Solscan. Contract address ${GHALL_CA}`}
  >
    <span>$GUILD CA</span>
    <code>{GHALL_CA}</code>
  </a>;
}
