import type { MenubarThreadTarget } from './backend.js';
import {
  requireUsableProvider,
  validatedProviderId,
  type ProviderStatusProbe,
} from './auth-guard.js';

export interface TodayRecapAuthorizationSource extends ProviderStatusProbe {
  todayRecapsEnabled(provider: string): boolean;
  allowTodayRecaps(provider: string): void;
}

/**
 * Persist the narrower permission used by Today-triggered inference.
 *
 * The requested provider must still be the current Today target and must be
 * usable now. Keeping this policy outside the renderer makes a forged IPC call
 * no more privileged than the button it is trying to imitate.
 */
export async function grantTodayRecapPermission(
  value: unknown,
  target: Pick<MenubarThreadTarget, 'provider'>,
  source: TodayRecapAuthorizationSource | null,
): Promise<true> {
  const provider = validatedProviderId(value);
  if (!provider || !source) {
    throw new Error('That Today recap provider is not supported.');
  }
  if (provider !== validatedProviderId(target.provider)) {
    throw new Error('The Today recap provider changed. Try again.');
  }

  await requireUsableProvider(
    provider,
    source,
    'Connect the Today recap provider before allowing generation.',
  );
  try {
    source.allowTodayRecaps(provider);
    if (!source.todayRecapsEnabled(provider)) {
      throw new Error('permission was not saved');
    }
  } catch {
    throw new Error('Aside could not save Today recap permission.');
  }
  return true;
}

/** Execute generation only after the main process re-probes both permissions. */
export async function runAuthorizedTodayRecap<T>(
  target: MenubarThreadTarget,
  source: TodayRecapAuthorizationSource | null,
  generate: (authorizedTarget: MenubarThreadTarget) => Promise<T>,
): Promise<T> {
  const provider = await requireUsableProvider(
    target.provider,
    source,
    'Connect the Today recap provider before generating.',
  );
  let allowed = false;
  try {
    allowed = source?.todayRecapsEnabled(provider) === true;
  } catch {
    allowed = false;
  }
  if (!allowed) throw new Error('Allow Today recaps before generating.');
  return generate({ ...target, provider });
}
