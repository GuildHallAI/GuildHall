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

const runtimeTokens = [...new Set([
  process.env.GUILDHALL_AGENT_RUNTIME_TOKEN?.trim(),
  ...(process.env.GUILDHALL_AGENT_RUNTIME_TOKENS ?? "").split(",").map((token) => token.trim()),
].filter((token): token is string => Boolean(token)))];
if (!runtimeTokens.length) throw new Error("Set GUILDHALL_AGENT_RUNTIME_TOKEN or GUILDHALL_AGENT_RUNTIME_TOKENS.");

export const config = {
  groqApiKey: required("GROQ_API_KEY"),
  groqModel: required("GROQ_MODEL"),
  tavilyApiKey: required("TAVILY_API_KEY"),
  backendUrl: backendUrl.toString().replace(/\/$/, ""),
  runtimeToken: runtimeTokens[0]!,
  runtimeTokens,
  openRouterApiKey: process.env.OPENROUTER_API_KEY?.trim() ?? "",
  openRouterImageModel: process.env.OPENROUTER_IMAGE_MODEL?.trim() || "recraft/recraft-v4.1-flash",
  port: integer("PORT", 3100, 1, 65535),
  pollIntervalMs: integer("POLL_INTERVAL_MS", 30_000, 10_000, 600_000),
};
