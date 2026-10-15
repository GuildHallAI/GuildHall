export type Source = { title: string; url: string; content: string };

export function formatSourcedAnswer(summary: string, citedUrls: string[], sources: Source[]) {
  const allowed = new Set(sources.map((source) => source.url));
  const safeUrls = [...new Set(citedUrls.filter((url) => allowed.has(url)))];
  if (!summary.trim() || !safeUrls.length) throw new Error("The research result did not include a source-backed answer.");
  return {
    summary: `${summary.trim()}\n\nSources:\n${safeUrls.map((url) => `- ${url}`).join("\n")}`.slice(0, 4900),
    citedUrls: safeUrls,
  };
}
