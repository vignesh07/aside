import {
  constantTimeEqualText,
  createAdminSessionToken,
  isAdminSessionTokenValid,
} from "./admin-auth-core.mjs";

export const ADMIN_SESSION_COOKIE = "aside_admin_session";
export const ADMIN_SESSION_SECONDS = 12 * 60 * 60;

export function configuredAdminKey(): string | null {
  const key = process.env.ASIDE_ADMIN_KEY?.trim();
  return key ? key : null;
}

export async function submittedAdminKeyIsValid(
  submittedKey: string,
): Promise<boolean> {
  const adminKey = configuredAdminKey();
  if (!adminKey) {
    return false;
  }

  return constantTimeEqualText(submittedKey, adminKey);
}

export async function adminSessionToken(): Promise<string | null> {
  const adminKey = configuredAdminKey();
  return adminKey
    ? createAdminSessionToken(
        adminKey,
        Date.now() + ADMIN_SESSION_SECONDS * 1000,
      )
    : null;
}

export async function adminSessionIsValid(
  token: string | undefined,
): Promise<boolean> {
  const adminKey = configuredAdminKey();
  return adminKey
    ? isAdminSessionTokenValid(token ?? "", adminKey)
    : false;
}
