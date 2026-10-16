function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function integer(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name];
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

const backendUrl = new URL(required("GUILDHALL_BACKEND_URL"));
if (backendUrl.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(backendUrl.hostname)) {
  throw new Error("GUILDHALL_BACKEND_URL must use HTTPS outside localhost.");
}

const runtimeProfiles = new Map<string, string>();
const hallScoutToken = process.env.GUILDHALL_AGENT_HALLSCOUT_RUNTIME_TOKEN?.trim()
  || process.env.GUILDHALL_AGENT_RUNTIME_TOKEN?.trim();
const hallwrightToken = process.env.GUILDHALL_AGENT_HALLWRIGHT_RUNTIME_TOKEN?.trim();
if (hallScoutToken) runtimeProfiles.set("hall-scout", hallScoutToken);
if (hallwrightToken) runtimeProfiles.set("hallwright", hallwrightToken);
for (const [index, token] of (process.env.GUILDHALL_AGENT_RUNTIME_TOKENS ?? "").split(",").map((value) => value.trim()).filter(Boolean).entries()) {
  runtimeProfiles.set(`additional-${index + 1}`, token);
}
const seenTokens = new Set<string>();
const configuredProfiles: Array<{ name: string; token: string }> = [];
for (const [name, token] of runtimeProfiles) {
  if (seenTokens.has(token)) continue;
  seenTokens.add(token);
  configuredProfiles.push({ name, token });
}
if (!configuredProfiles.length) {
  throw new Error("Set GUILDHALL_AGENT_HALLSCOUT_RUNTIME_TOKEN, GUILDHALL_AGENT_HALLWRIGHT_RUNTIME_TOKEN, or the legacy GUILDHALL_AGENT_RUNTIME_TOKEN.");
}

export const config = {
  groqApiKey: required("GROQ_API_KEY"),
  groqModel: required("GROQ_MODEL"),
  tavilyApiKey: required("TAVILY_API_KEY"),
  backendUrl: backendUrl.toString().replace(/\/$/, ""),
  runtimeToken: configuredProfiles[0]!.token,
  runtimeProfiles: configuredProfiles,
  runtimeTokens: configuredProfiles.map((profile) => profile.token),
  openRouterApiKey: process.env.OPENROUTER_API_KEY?.trim() ?? "",
  openRouterImageModel: process.env.OPENROUTER_IMAGE_MODEL?.trim() || "recraft/recraft-v4.1-flash",
  port: integer("PORT", 3100, 1, 65535),
  pollIntervalMs: integer("POLL_INTERVAL_MS", 30_000, 10_000, 600_000),
};
