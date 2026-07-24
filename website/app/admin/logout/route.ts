import { NextResponse } from "next/server";
import { ADMIN_SESSION_COOKIE } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

export function POST() {
  const response = new NextResponse(null, {
    status: 303,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      Location: "/admin",
    },
  });
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
