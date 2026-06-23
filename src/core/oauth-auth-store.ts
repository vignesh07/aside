import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_AUTH_FILE } from '../config/defaults.js';
import type { OAuthCredentials } from '@mariozechner/pi-ai';

interface AuthStoreData {
  authFilePath: string;
  rawAuth: Record<string, unknown>;
  credentials: Record<string, OAuthCredentials>;
  wrappedProviders: Set<string>;
}

interface OAuthApiKeyResult {
  apiKey: string;
  newCredentials: OAuthCredentials;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isOAuthCredentials(value: unknown): value is OAuthCredentials {
  if (!isRecord(value)) return false;
  return typeof value['access'] === 'string'
    && typeof value['refresh'] === 'string'
    && typeof value['expires'] === 'number';
}

export function resolveAuthFilePath(authFile?: string): string {
  const configured = authFile?.trim()
    || process.env['TALKATUI_AUTH_FILE']?.trim()
    || DEFAULT_AUTH_FILE;
  return path.resolve(configured);
}

export function hasOAuthCredentialsForProvider(provider: string, authFile?: string): boolean {
  const normalized = provider.trim();
  if (!normalized) return false;
  const store = loadAuthStore(authFile);
  return !!store.credentials[normalized];
}

export async function resolveOAuthApiKeyForProvider(
  provider: string,
  authFile: string | undefined,
  getOAuthApiKey: (provider: string, credentials: Record<string, OAuthCredentials>) => Promise<OAuthApiKeyResult | null>,
): Promise<string | null> {
  const normalized = provider.trim();
  if (!normalized) return null;

  const store = loadAuthStore(authFile);
  if (!store.credentials[normalized]) return null;

  const result = await getOAuthApiKey(normalized, store.credentials);
  if (!result) return null;

  const previous = store.credentials[normalized];
  if (!previous || JSON.stringify(previous) !== JSON.stringify(result.newCredentials)) {
    persistProviderCredentials(store, normalized, result.newCredentials);
  }

  return result.apiKey;
}

function loadAuthStore(authFile?: string): AuthStoreData {
  const authFilePath = resolveAuthFilePath(authFile);
  const rawAuth = readAuthFile(authFilePath);
  const credentials: Record<string, OAuthCredentials> = {};
  const wrappedProviders = new Set<string>();

  for (const [provider, value] of Object.entries(rawAuth)) {
    if (!isRecord(value)) continue;

    if (value['type'] === 'oauth' && isOAuthCredentials(value)) {
      wrappedProviders.add(provider);
      const { type: _type, ...rest } = value;
      credentials[provider] = {
        ...rest,
        access: value['access'],
        refresh: value['refresh'],
        expires: value['expires'],
      };
      continue;
    }

    if (isOAuthCredentials(value)) {
      credentials[provider] = value;
    }
  }

  return { authFilePath, rawAuth, credentials, wrappedProviders };
}

function readAuthFile(authFilePath: string): Record<string, unknown> {
  if (!fs.existsSync(authFilePath)) return {};

  try {
    const raw = fs.readFileSync(authFilePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function persistProviderCredentials(
  store: AuthStoreData,
  provider: string,
  credentials: OAuthCredentials,
): void {
  const useWrapped = store.wrappedProviders.has(provider);
  store.rawAuth[provider] = useWrapped
    ? { type: 'oauth', ...credentials }
    : { ...credentials };

  writeAuthFile(store.authFilePath, store.rawAuth);
}

function writeAuthFile(authFilePath: string, auth: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(authFilePath), { recursive: true });
    const tmpPath = `${authFilePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(auth, null, 2), 'utf-8');
    fs.renameSync(tmpPath, authFilePath);
  } catch {
    // Ignore auth persistence failures; runtime can continue with in-memory key.
  }
}
