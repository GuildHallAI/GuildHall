export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    {
      version: process.env.npm_package_version ?? "0.1.0",
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? "unknown",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
