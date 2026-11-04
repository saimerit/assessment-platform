'use client';

import { useEffect, useMemo, useState } from 'react';
import { LockKeyholeIcon } from '@/lib/solar-icons';

interface Invitation {
  exam_title: string;
  candidate_name: string;
  email: string;
  scheduled_start: string;
  scheduled_end: string;
  server_time: string;
  window_status: 'NOT_OPEN' | 'OPEN' | 'CLOSED';
  min_client_version?: string;
  latest_client_url?: string;
}

interface ClientProbe {
  version?: string;
  status?: string;
}

const API_BASE = '/api';
// The API supplies the configured release URL. A missing value intentionally
// leaves the link unavailable rather than sending candidates to a baked host.
const CLIENT_DOWNLOAD_URL = '';
const CLIENT_PROBE_URL = 'http://127.0.0.1:48991/version';

function compareVersions(installed: string, required: string): number {
  const installedParts = installed.split('.').map((part) => Number.parseInt(part, 10));
  const requiredParts = required.split('.').map((part) => Number.parseInt(part, 10));
  const length = Math.max(installedParts.length, requiredParts.length);
  for (let index = 0; index < length; index += 1) {
    const installedPart = installedParts[index] ?? 0;
    const requiredPart = requiredParts[index] ?? 0;
    if (!Number.isFinite(installedPart) || !Number.isFinite(requiredPart)) return 0;
    if (installedPart !== requiredPart) return installedPart > requiredPart ? 1 : -1;
  }
  return 0;
}

export default function ExamGateway({ token }: { token: string }) {
  const deepLink = useMemo(() => {
    const url = new URL('lockdown://open');
    url.searchParams.set('token', token);
    return url.toString();
  }, [token]);
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [windowStatus, setWindowStatus] = useState<Invitation['window_status'] | null>(null);
  const [serverTime, setServerTime] = useState('');
  const [error, setError] = useState('');
  const [clientDetected, setClientDetected] = useState<boolean | null>(null);
  const [clientVersion, setClientVersion] = useState<string | null>(null);
  const [checkingClient, setCheckingClient] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${API_BASE}/exg/${encodeURIComponent(token)}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error || 'This invitation is invalid or unavailable. Contact your assessment organizer.');
        }
        return (await response.json()) as Invitation;
      })
      .then((loaded) => {
        setInvitation(loaded);
        setWindowStatus(loaded.window_status);
        setServerTime(loaded.server_time);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Unable to load this invitation.');
      });
    return () => controller.abort();
  }, [token]);

  useEffect(() => {
    if (!invitation) return;
    let active = true;
    const refreshWindowStatus = async () => {
      try {
        const response = await fetch(`${API_BASE}/exg/${encodeURIComponent(token)}`, { cache: 'no-store' });
        if (!response.ok) return;
        const current = (await response.json()) as Invitation;
        if (!active) return;
        setWindowStatus(current.window_status);
        setServerTime(current.server_time);
      } catch {
        // Keep the last server-confirmed status and retry on the next poll.
      }
    };
    const timer = window.setInterval(() => void refreshWindowStatus(), 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [invitation, token]);

  useEffect(() => {
    if (!invitation) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 2000);
    setCheckingClient(true);

    fetch(CLIENT_PROBE_URL, { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('Desktop client probe failed');
        return (await response.json()) as ClientProbe;
      })
      .then((probe) => {
        if (!probe.version) throw new Error('Desktop client version was not reported');
        setClientDetected(true);
        setClientVersion(probe.version);
      })
      .catch(() => {
        setClientDetected(false);
        setClientVersion(null);
      })
      .finally(() => {
        window.clearTimeout(timeout);
        setCheckingClient(false);
      });

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [invitation]);

  const minVersion = invitation?.min_client_version || '1.0.0';
  const downloadURL = invitation?.latest_client_url || CLIENT_DOWNLOAD_URL;
  const versionOutdated = Boolean(clientVersion && compareVersions(clientVersion, minVersion) < 0);
  const windowOpen = windowStatus === 'OPEN';

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 p-6 text-slate-100">
      <section className="w-full max-w-lg space-y-6 rounded-2xl border border-slate-800 bg-slate-900 p-8 shadow-2xl">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-blue-500/20 bg-blue-500/10 text-blue-300" aria-hidden="true">
          <LockKeyholeIcon size={28} />
        </div>
        <div className="text-center">
          <h1 className="text-xl font-bold">Secure Exam Gateway</h1>
          {invitation ? (
            <>
              <p className="mt-2 text-sm text-slate-300">{invitation.exam_title}</p>
              <p className="mt-1 text-xs text-slate-400">Invited: {invitation.candidate_name} ({invitation.email})</p>
            </>
          ) : error ? (
            <p role="alert" className="mt-2 text-sm text-rose-300">{error}</p>
          ) : (
            <p className="mt-2 text-sm text-slate-400">Verifying your invitation…</p>
          )}
        </div>

        {invitation && <>
          <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/70 p-4">
            <div className="flex justify-between gap-3 text-xs"><span className="text-slate-400">Scheduled start</span><span className="text-right">{new Date(invitation.scheduled_start).toLocaleString()}</span></div>
            <div className="flex justify-between gap-3 text-xs"><span className="text-slate-400">Scheduled end</span><span className="text-right">{new Date(invitation.scheduled_end).toLocaleString()}</span></div>
            <div className="border-t border-slate-800 pt-3 text-center">
              <p className={`text-sm font-semibold ${windowStatus === 'OPEN' ? 'text-emerald-300' : windowStatus === 'CLOSED' ? 'text-rose-300' : 'text-amber-200'}`}>{windowStatus === 'OPEN' ? 'The exam window is open' : windowStatus === 'CLOSED' ? 'The exam window has closed' : 'The exam has not started yet'}</p>
              <p className="mt-1 text-[10px] text-slate-500">Server checked: {serverTime ? new Date(serverTime).toLocaleString() : 'Checking…'}</p>
            </div>
          </div>

          <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/70 p-4">
            <div className="flex justify-between gap-3 text-xs">
              <span className="text-slate-400">Lockdown Client</span>
              <span className="text-right">
                {checkingClient ? 'Checking…' : clientDetected ? `Detected (v${clientVersion})` : 'Not detected'}
              </span>
            </div>
            <div className="flex justify-between gap-3 text-xs">
              <span className="text-slate-400">Minimum required</span>
              <span className="font-mono">v{minVersion}</span>
            </div>
          </div>

          {!windowOpen ? (
            <div className="space-y-3 text-center">
              <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">The server allows entry only during the scheduled exam window. This page checks again automatically.</p>
              {!clientDetected && !checkingClient && <a href={downloadURL} className="block rounded-lg border border-slate-700 bg-slate-800 px-4 py-3 text-center text-sm font-medium text-slate-200 transition hover:bg-slate-700">Download Lockdown Client (.exe)</a>}
            </div>
          ) : versionOutdated ? (
            <div className="space-y-3 text-center">
              <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
                Your client is outdated. Update to v{minVersion} or newer before starting this assessment.
              </p>
              <a href={downloadURL} className="block rounded-lg bg-amber-500 px-4 py-3 text-center text-sm font-semibold text-slate-950 transition hover:bg-amber-400">
                Update Lockdown Client (.exe)
              </a>
            </div>
          ) : clientDetected ? (
            <a href={deepLink} className="block rounded-lg bg-blue-600 px-4 py-3 text-center text-sm font-medium text-white transition hover:bg-blue-500">
              Launch Lockdown Client
            </a>
          ) : !checkingClient ? (
            <div className="space-y-3">
              <a href={deepLink} className="block rounded-lg bg-blue-600 px-4 py-3 text-center text-sm font-medium text-white transition hover:bg-blue-500">
                I Have the Client — Open
              </a>
              <a href={downloadURL} className="block rounded-lg border border-slate-700 bg-slate-800 px-4 py-3 text-center text-sm font-medium text-slate-200 transition hover:bg-slate-700">
                Download Client (.exe)
              </a>
            </div>
          ) : null}
        </>}

        <p className="text-center text-xs text-slate-500">Keep this personal invitation link private.</p>
      </section>
    </main>
  );
}
