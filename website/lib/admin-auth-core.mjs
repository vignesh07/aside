const SESSION_CONTEXT = "aside-admin-session:v1:";
const encoder = new TextEncoder();

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

async function digest(value) {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(value)),
  );
}

async function sessionSignature(adminKey, expiresAtMs) {
  const signingKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(adminKey),
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    signingKey,
    encoder.encode(`${SESSION_CONTEXT}${expiresAtMs}`),
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

export function constantTimeEqualBytes(left, right) {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;

  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }

  return difference === 0;
}

export async function constantTimeEqualText(left, right) {
  const [leftDigest, rightDigest] = await Promise.all([
    digest(left),
    digest(right),
  ]);
  return constantTimeEqualBytes(leftDigest, rightDigest);
}

export async function createAdminSessionToken(adminKey, expiresAtMs) {
  const expiresAt = Math.trunc(expiresAtMs);
  return `${expiresAt}.${await sessionSignature(adminKey, expiresAt)}`;
}

export async function isAdminSessionTokenValid(
  token,
  adminKey,
  { nowMs = Date.now() } = {},
) {
  if (!token || !adminKey) {
    return false;
  }

  const [expiresAtText, signature, ...extraParts] = token.split(".");
  const expiresAt = Number(expiresAtText);

  if (
    extraParts.length > 0 ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= nowMs ||
    !/^[A-Za-z0-9_-]{43}$/.test(signature ?? "")
  ) {
    return false;
  }

  const expectedSignature = await sessionSignature(adminKey, expiresAt);
  return constantTimeEqualText(signature, expectedSignature);
}
