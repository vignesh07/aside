import {
  redirectToRelease,
  trackDownloadAndRedirect,
} from "../release-route";

export function GET(): Promise<Response> {
  return trackDownloadAndRedirect("mac-arm64", "/download/mac-arm64");
}

export function HEAD(): Response {
  return redirectToRelease("/download/mac-arm64");
}
