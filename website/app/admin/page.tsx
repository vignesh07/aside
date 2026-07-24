import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { cookies } from "next/headers";
import {
  ADMIN_SESSION_COOKIE,
  adminSessionIsValid,
  configuredAdminKey,
} from "@/lib/admin-auth";
import {
  configuredAnalyticsDatabasePath,
  readDownloadAnalytics,
} from "@/lib/analytics-store.mjs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Download analytics — Aside",
  description: "Private download analytics for Aside.",
  alternates: {
    canonical: "/admin",
  },
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};

type PeriodCounts = {
  total: number;
  macArm64: number;
  macIntel: number;
};

type DownloadAnalytics = {
  asOf: string;
  trackingStartedAt: string | null;
  periods: {
    days7: PeriodCounts;
    days30: PeriodCounts;
    allTime: PeriodCounts;
  };
};

type AdminPageProps = {
  searchParams: Promise<{
    error?: string | string[];
  }>;
};

function displayDate(value: string | null): string {
  if (!value) {
    return "No downloads yet";
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));
}

function AnalyticsCard({
  label,
  counts,
}: {
  label: string;
  counts: PeriodCounts;
}) {
  return (
    <article className="analytics-card">
      <p>{label}</p>
      <strong>{counts.total.toLocaleString("en-US")}</strong>
      <div className="analytics-breakdown">
        <span>
          <b>{counts.macArm64.toLocaleString("en-US")}</b>
          Apple silicon
        </span>
        <span>
          <b>{counts.macIntel.toLocaleString("en-US")}</b>
          Intel
        </span>
      </div>
    </article>
  );
}

function AdminFrame({ children }: { children: React.ReactNode }) {
  return (
    <main className="admin-page">
      <nav className="admin-nav" aria-label="Admin navigation">
        <Link className="brand" href="/" aria-label="Aside home">
          <Image src="/aside-icon.svg" alt="" width={30} height={30} />
          <span>Aside</span>
        </Link>
        <span>Private analytics</span>
      </nav>
      {children}
    </main>
  );
}

function LockedAdmin({
  configured,
  invalidKey,
}: {
  configured: boolean;
  invalidKey: boolean;
}) {
  return (
    <AdminFrame>
      <section className="admin-lock">
        <div className="admin-lock-mark" aria-hidden="true">
          a
        </div>
        <p className="eyebrow">Download analytics</p>
        <h1>{configured ? "Enter the admin key." : "Analytics isn’t configured yet."}</h1>
        <p className="admin-lock-copy">
          {configured
            ? "This page contains private download totals for Aside."
            : "Add ASIDE_ADMIN_KEY to the aside-web service in Railway, then reload this page."}
        </p>

        {configured ? (
          <form className="admin-key-form" method="post" action="/admin/session">
            <label htmlFor="admin-key">Admin key</label>
            <div>
              <input
                id="admin-key"
                name="key"
                type="password"
                autoComplete="current-password"
                autoCapitalize="none"
                spellCheck="false"
                required
                autoFocus
                aria-invalid={invalidKey || undefined}
                aria-describedby={invalidKey ? "admin-key-error" : undefined}
              />
              <button type="submit">Open analytics</button>
            </div>
            {invalidKey ? (
              <p id="admin-key-error" className="admin-form-error" role="alert">
                That key didn’t match.
              </p>
            ) : null}
          </form>
        ) : (
          <p className="admin-setup-note">
            Use a long random value, for example{" "}
            <code>openssl rand -base64 32</code>.
          </p>
        )}
      </section>
    </AdminFrame>
  );
}

export default async function AdminPage({ searchParams }: AdminPageProps) {
  const adminKeyConfigured = configuredAdminKey() !== null;
  const sessionCookie = (await cookies()).get(ADMIN_SESSION_COOKIE)?.value;
  const authenticated =
    adminKeyConfigured && (await adminSessionIsValid(sessionCookie));
  const error = (await searchParams).error;
  const invalidKey =
    error === "invalid" || (Array.isArray(error) && error.includes("invalid"));

  if (!authenticated) {
    return (
      <LockedAdmin configured={adminKeyConfigured} invalidKey={invalidKey} />
    );
  }

  let analytics: DownloadAnalytics | null = null;
  let analyticsError = false;

  try {
    analytics = (await readDownloadAnalytics()) as DownloadAnalytics;
  } catch {
    analyticsError = true;
  }

  return (
    <AdminFrame>
      <section className="admin-dashboard">
        <header className="admin-dashboard-head">
          <div>
            <p className="eyebrow">Download starts</p>
            <h1>Aside downloads</h1>
            <p>
              Installer handoffs from aside.vgnsh.xyz. No IP addresses,
              referrers, or browser details are collected.
            </p>
          </div>
          <form method="post" action="/admin/logout">
            <button className="admin-logout" type="submit">
              Lock page
            </button>
          </form>
        </header>

        {analyticsError || !analytics ? (
          <div className="admin-storage-error" role="alert">
            <strong>Analytics storage is unavailable.</strong>
            <span>
              {configuredAnalyticsDatabasePath()
                ? "The database could not be read. Check the aside-web deployment logs."
                : "Attach the Railway volume at /data, then redeploy aside-web."}
            </span>
          </div>
        ) : (
          <>
            <div className="analytics-grid">
              <AnalyticsCard label="Last 7 days" counts={analytics.periods.days7} />
              <AnalyticsCard
                label="Last 30 days"
                counts={analytics.periods.days30}
              />
              <AnalyticsCard label="All time" counts={analytics.periods.allTime} />
            </div>

            <footer className="analytics-footnote">
              <span>
                Tracking began <b>{displayDate(analytics.trackingStartedAt)}</b>
              </span>
              <span>
                Updated{" "}
                <b>
                  {new Intl.DateTimeFormat("en-US", {
                    hour: "numeric",
                    minute: "2-digit",
                    timeZoneName: "short",
                  }).format(new Date(analytics.asOf))}
                </b>
              </span>
            </footer>
          </>
        )}

        <p className="analytics-definition">
          A count is recorded when the website hands a DMG request to the
          release service. It does not claim the browser completed the file.
        </p>
      </section>
    </AdminFrame>
  );
}
