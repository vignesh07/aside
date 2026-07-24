import {
  redirectToRelease,
  trackDownloadAndRedirect,
} from "../release-route";

export function GET(): Promise<Response> {
  return trackDownloadAndRedirect("mac-intel", "/download/mac-intel");
}

export function HEAD(): Response {
  return redirectToRelease("/download/mac-intel");
}
