// electron-builder afterSign hook: notarize the signed .app.
//
// Credentials deliberately never appear here, in the repo, or in CI logs. They
// live in the macOS keychain under a notarytool profile, created once by:
//
//   xcrun notarytool store-credentials "fold-notary" \
//     --apple-id "<your-apple-id>" \
//     --team-id 8ZS766K9K4 \
//     --password "<app-specific-password>"
//
// The app-specific password (appleid.apple.com -> Sign-In and Security) is
// scoped and revocable — it is not your Apple ID password, and it should never
// be pasted into a file. Once stored, this hook only needs the profile name.
//
// Skips cleanly when the profile isn't set up, so `npm run pack` and unsigned
// local builds keep working for anyone without a Developer ID.

import { notarize } from '@electron/notarize';
import { execFileSync } from 'node:child_process';

const PROFILE = process.env['ASIDE_NOTARY_PROFILE'] ?? 'fold-notary';

/** True if a notarytool profile of this name exists in the keychain. */
function profileExists(profile) {
  try {
    // `notarytool history` is the cheapest call that authenticates the profile.
    execFileSync('xcrun', ['notarytool', 'history', '--keychain-profile', profile], {
      stdio: 'ignore',
      timeout: 60_000,
    });
    return true;
  } catch {
    return false;
  }
}

export default async function notarizing(context) {
  const { electronPlatformName, appOutDir, packager } = context;
  if (electronPlatformName !== 'darwin') return;

  if (process.env['ASIDE_SKIP_NOTARIZE'] === '1') {
    console.log('  • notarize skipped  reason=ASIDE_SKIP_NOTARIZE=1');
    return;
  }

  const appName = packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  if (!profileExists(PROFILE)) {
    // Not fatal: an unsigned/un-notarized local build is a legitimate outcome.
    // But say so loudly — silently shipping an un-notarized app is how you find
    // out from a user that Gatekeeper blocked it.
    console.warn(
      `  • notarize SKIPPED — no keychain profile "${PROFILE}".\n` +
        `    The .app is signed but NOT notarized; Gatekeeper will block it on other machines.\n` +
        `    Create the profile with:\n` +
        `      xcrun notarytool store-credentials "${PROFILE}" --apple-id <id> --team-id 8ZS766K9K4 --password <app-specific-password>`,
    );
    return;
  }

  console.log(`  • notarizing  app=${appPath} profile=${PROFILE}`);
  await notarize({ tool: 'notarytool', appPath, keychainProfile: PROFILE });
  console.log('  • notarized + stapled');
}
