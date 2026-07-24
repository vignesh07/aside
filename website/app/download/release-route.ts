const RELEASE_SERVICE_ORIGIN =
  "https://aside-production-fd82.up.railway.app";

export function redirectToRelease(pathname: string): Response {
  return new Response(null, {
    status: 307,
    headers: {
      Location: new URL(pathname, RELEASE_SERVICE_ORIGIN).href,
      "Cache-Control": "no-store",
    },
  });
}
