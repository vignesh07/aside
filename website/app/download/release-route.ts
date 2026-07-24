import { recordDownload } from "@/lib/analytics-store.mjs";

const RELEASE_SERVICE_ORIGIN =
  "https://aside-production-fd82.up.railway.app";

type DownloadArtifact = "mac-arm64" | "mac-intel";

export function redirectToRelease(pathname: string): Response {
  return new Response(null, {
    status: 307,
    headers: {
      Location: new URL(pathname, RELEASE_SERVICE_ORIGIN).href,
      "Cache-Control": "no-store",
    },
  });
}

export async function trackDownloadAndRedirect(
  artifact: DownloadArtifact,
  pathname: string,
): Promise<Response> {
  try {
    await recordDownload(artifact);
  } catch (error) {
    console.error("download_analytics_write_failed", {
      artifact,
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }

  return redirectToRelease(pathname);
}
