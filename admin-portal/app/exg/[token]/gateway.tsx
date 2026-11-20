'use client';

import { useEffect, useMemo, useState } from 'react';
import { LockKeyholeIcon } from '@/lib/solar-icons';
import styles from './gateway.module.css';

interface Invitation {
  exam_title: string;
  candidate_name: string;
  email: string;
  scheduled_start: string;
  scheduled_end: string;
  server_time: string;
  window_status: 'NOT_OPEN' | 'OPEN' | 'IN_PROGRESS' | 'CLOSED' | 'EXPIRED' | 'SUBMITTED';
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

function DownloadAction({ url, update = false }: { url: string; update?: boolean }) {
  if (!url) return <p className={styles.description}>Contact your assessment organizer for the latest client download.</p>;
  return <a href={url} className={update ? styles.primaryAction : styles.secondaryAction}>{update ? 'Update Lockdown Client (.exe)' : 'Download Lockdown Client (.exe)'}</a>;
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
  const submitted = windowStatus === 'SUBMITTED';
  const windowOpen = windowStatus === 'OPEN' || windowStatus === 'IN_PROGRESS' || submitted;
  const statusLabel = submitted ? 'Your assessment is submitted' : windowStatus === 'IN_PROGRESS' ? 'Your exam timer is running' : windowStatus === 'OPEN' ? 'The exam window is open' : windowStatus === 'EXPIRED' ? 'Your saved responses are being finalized' : windowStatus === 'CLOSED' ? 'The exam window has closed' : 'The exam has not started yet';

  return (
    <div className={styles.page}>
      <header className={styles.header}><strong>✦ OA SECURE CLIENT</strong><span>Secure assessment access</span></header>
      <main className={styles.content}>
        <section className={styles.panel} aria-labelledby="gateway-title">
          <div className={styles.brand}><span className={styles.brandMark} aria-hidden="true">A</span><span className={styles.brandName}>AssessPro</span><span className={styles.candidateBadge}>Candidate</span></div>
          <p className={styles.eyebrow}>Assessment check-in</p>
          <h1 id="gateway-title" className={styles.title}>Secure Exam Gateway</h1>
          <p className={styles.description}>Check your schedule and client before continuing to your assessment.</p>
          {error ? <p role="alert" className={styles.error}>{error}</p> : !invitation ? <p role="status" className={styles.description}>Verifying your invitation…</p> : <>
            <div className={styles.invitation}><h2 className={styles.examTitle}>{invitation.exam_title}</h2><p className={styles.candidate}>Invited: {invitation.candidate_name} ({invitation.email})</p></div>
            <section className={styles.card} aria-labelledby="gateway-schedule-title">
              <h2 id="gateway-schedule-title" className={styles.cardHeading}>Your entry window</h2>
              <dl className={styles.details}>
                <div className={styles.detail}><dt>Scheduled start</dt><dd><time dateTime={invitation.scheduled_start}>{new Date(invitation.scheduled_start).toLocaleString()}</time></dd></div>
                <div className={styles.detail}><dt>Scheduled end</dt><dd><time dateTime={invitation.scheduled_end}>{new Date(invitation.scheduled_end).toLocaleString()}</time></dd></div>
              </dl>
              <div className={styles.statusRow}><span className={styles.status + ' ' + (windowOpen ? styles.open : windowStatus === 'CLOSED' ? styles.closed : styles.waiting)}>{statusLabel}</span><span className={styles.serverTime}>Server checked: {serverTime ? new Date(serverTime).toLocaleString() : 'Checking…'}</span></div>
            </section>
            <section className={styles.card} aria-labelledby="gateway-client-title">
              <h2 id="gateway-client-title" className={styles.cardHeading}><LockKeyholeIcon size={18} aria-hidden="true" />Client compatibility</h2>
              <dl className={styles.details}>
                <div className={styles.detail}><dt>Lockdown Client</dt><dd className={styles.version}>{checkingClient ? 'Checking…' : clientDetected ? 'Detected (v' + clientVersion + ')' : 'Not detected'}</dd></div>
                <div className={styles.detail}><dt>Minimum required</dt><dd className={styles.version}>v{minVersion}</dd></div>
              </dl>
            </section>
            {!windowOpen ? <>
              <div className={styles.notice} role="status"><strong>Waiting for your exam window</strong><p>The server allows entry only during the scheduled exam window. This page checks again automatically.</p></div>
              {!clientDetected && !checkingClient && <DownloadAction url={downloadURL} />}
            </> : versionOutdated ? <>
              <div className={styles.notice} role="status"><strong>A client update is required</strong><p>Your client is outdated. Update to v{minVersion} or newer before starting this assessment.</p></div>
              <DownloadAction url={downloadURL} update />
            </> : clientDetected ? <a href={deepLink} className={styles.primaryAction}>{submitted ? 'Open Client to View Receipt' : 'Launch Lockdown Client'}</a> : !checkingClient ? <div className={styles.actions}>
              <a href={deepLink} className={styles.primaryAction}>{submitted ? 'I Have the Client — View Receipt' : 'I Have the Client — Open'}</a><DownloadAction url={downloadURL} />
            </div> : null}
          </>}
          <p className={styles.privacy}>Keep this personal invitation link private.</p>
        </section>
      </main>
      <footer className={styles.footer}>{submitted ? 'Sign in with your invited candidate account to retrieve the receipt.' : windowStatus === 'IN_PROGRESS' ? 'Your original exam timer continues while you reconnect.' : 'Assessment check-in · Your exam timer begins when you enter the exam.'}</footer>
    </div>
  );
}
