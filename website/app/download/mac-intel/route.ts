import { redirectToRelease } from "../release-route";

export function GET(): Response {
  return redirectToRelease("/download/mac-intel");
}

export const HEAD = GET;
