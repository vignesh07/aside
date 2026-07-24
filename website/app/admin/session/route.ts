import { NextResponse } from "next/server";
import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_SECONDS,
  adminSessionToken,
  configuredAdminKey,
  submittedAdminKeyIsValid,
} from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

function redirectToAdmin(error?: string) {
  const location = error
    ? `/admin?error=${encodeURIComponent(error)}`
    : "/admin";

  return new NextResponse(null, {
    status: 303,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      Location: location,
    },
  });
}

export async function POST(request: Request) {
  if (!configuredAdminKey()) {
    return redirectToAdmin("not-configured");
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 4096) {
    return redirectToAdmin("invalid");
  }

  const body = await request.text();
  if (body.length > 4096) {
    return redirectToAdmin("invalid");
  }

  const submittedKey = new URLSearchParams(body).get("key") ?? "";
  if (
    submittedKey.length > 512 ||
    !(await submittedAdminKeyIsValid(submittedKey))
  ) {
    const response = redirectToAdmin("invalid");
    response.cookies.set({
      name: ADMIN_SESSION_COOKIE,
      value: "",
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/admin",
      maxAge: 0,
    });
    return response;
  }

  const token = await adminSessionToken();
  if (!token) {
    return redirectToAdmin("not-configured");
  }

  const response = redirectToAdmin();
  response.cookies.set({
    name: ADMIN_SESSION_COOKIE,
    value: token,
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/admin",
    maxAge: ADMIN_SESSION_SECONDS,
  });
  return response;
}
