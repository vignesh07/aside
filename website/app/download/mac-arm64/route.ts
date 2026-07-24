import { redirectToRelease } from "../release-route";

export function GET(): Response {
  return redirectToRelease("/download/mac-arm64");
}

export const HEAD = GET;
