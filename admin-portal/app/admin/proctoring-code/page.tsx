'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { fetchWithAuth } from '@/lib/api';
import { AdminShell } from '../AdminShell';
import { CheckCircleIcon, ClockCircleIcon, LockKeyholeIcon } from '@/lib/solar-icons';

type ProctoringCode = {
    passcode: string;
    ttl_seconds: number;
    expires_at: string;
};

function formatRemaining(seconds: number): string {
    const safeSeconds = Math.max(0, seconds);
    const hours = Math.floor(safeSeconds / 3600);
    const minutes = Math.floor((safeSeconds % 3600) / 60);
    const remainingSeconds = safeSeconds % 60;
    return `${hours}h ${minutes}m ${remainingSeconds}s`;
}

export default function AdminProctoringCodePage() {
    const router = useRouter();
    const [code, setCode] = useState<ProctoringCode | null>(null);
    const [remaining, setRemaining] = useState(0);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    const [isError, setIsError] = useState(false);

    const loadCode = useCallback(async () => {
        const response = await fetchWithAuth('/admin/proctoring-code');
        const data = await response.json().catch(() => ({}));
        if (response.status === 404) {
            setCode(null);
            setRemaining(0);
            return;
        }
        if (!response.ok) throw new Error(data.error || 'Unable to load your proctoring code.');
        setCode(data as ProctoringCode);
        const expiresAt = Date.parse(data.expires_at);
        setRemaining(Number.isFinite(expiresAt) ? Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)) : data.ttl_seconds ?? 0);
    }, []);

    useEffect(() => {
        if (!localStorage.getItem('user')) { router.push('/login'); return; }
        void loadCode().catch((error: unknown) => {
            setIsError(true);
            setMessage(error instanceof Error ? error.message : 'Unable to load your proctoring code.');
        });
    }, [loadCode, router]);

    const hasTimeRemaining = remaining > 0;
    useEffect(() => {
        if (!code || !hasTimeRemaining) return;
        const timer = window.setInterval(() => setRemaining((value) => Math.max(0, value - 1)), 1000);
        return () => window.clearInterval(timer);
    }, [code, hasTimeRemaining]);

    const generateCode = async () => {
        setBusy(true);
        setMessage('');
        setIsError(false);
        try {
            const response = await fetchWithAuth('/admin/proctoring-code', { method: 'POST', body: JSON.stringify({}) });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || 'Unable to generate your proctoring code.');
            setCode(data as ProctoringCode);
            setRemaining(data.ttl_seconds ?? 0);
            setMessage('Your organization proctoring code is ready. Any previous code has been replaced.');
        } catch (error) {
            setIsError(true);
            setMessage(error instanceof Error ? error.message : 'Unable to generate your proctoring code.');
        } finally {
            setBusy(false);
        }
    };

    const copyCode = async () => {
        if (!code) return;
        try {
            await navigator.clipboard.writeText(code.passcode);
            setMessage('Proctoring code copied to clipboard.');
            setIsError(false);
        } catch {
            setMessage('Clipboard access was unavailable. Select and copy the code manually.');
            setIsError(true);
        }
    };

    return <AdminShell title="Proctoring Code" subtitle="Generate the organization admin code for online or offline proctored exams.">
        {message && <div role="status" className={`rounded-xl border px-4 py-3 text-sm ${isError ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-sky-200 bg-sky-50 text-sky-800'}`}>{message}</div>}

        <section className="overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-[0_8px_30px_-22px_rgba(15,23,42,.22)]">
            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 p-5 md:p-6">
                <div className="flex items-center gap-3">
                    <span className="grid h-11 w-11 place-items-center rounded-2xl bg-violet-50 text-violet-600"><LockKeyholeIcon size={22}/></span>
                    <div><h2 className="text-sm font-bold text-slate-800">Organization admin access</h2><p className="mt-1 max-w-2xl text-xs leading-relaxed text-slate-500">This code lets you act as the proctor for ONLINE_PROCTORING or OFFLINE_PROCTORING exams in your organization, even when you are not listed as an assigned event proctor.</p></div>
                </div>
                <button type="button" onClick={generateCode} disabled={busy} className="rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 px-4 py-2.5 text-xs font-bold text-white shadow-sm shadow-emerald-200 transition hover:from-emerald-600 hover:to-teal-600 disabled:cursor-not-allowed disabled:opacity-50">
                    {busy ? 'Generating…' : code ? 'Regenerate code' : 'Generate code'}
                </button>
            </div>

            <div className="grid gap-4 p-5 md:grid-cols-2 md:p-6">
                <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Your proctoring code</p>
                    {code && remaining > 0 ? <div className="mt-3 flex flex-wrap items-center justify-between gap-3"><code className="text-xl font-bold tracking-[0.18em] text-slate-800">{code.passcode}</code><button type="button" onClick={copyCode} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-[11px] font-semibold text-slate-600 transition hover:border-emerald-300 hover:text-emerald-700">Copy code</button></div> : <p className="mt-3 text-sm text-slate-500">{code ? 'This code has expired. Generate a new one to continue.' : 'No active code. Generate one when you are ready to proctor an exam.'}</p>}
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
                    <p className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-slate-400"><ClockCircleIcon size={14}/>Time remaining</p>
                    <p className={`mt-3 text-xl font-bold ${remaining > 0 ? 'text-slate-800' : 'text-slate-400'}`}>{code && remaining > 0 ? formatRemaining(remaining) : '—'}</p>
                    {code?.expires_at && <p className="mt-1 text-[10px] text-slate-400">Expires {new Date(code.expires_at).toLocaleString()}</p>}
                </div>
            </div>

            <div className="mx-5 mb-5 flex items-start gap-2 rounded-xl border border-emerald-100 bg-emerald-50/70 p-3.5 text-[11px] leading-relaxed text-emerald-800 md:mx-6 md:mb-6">
                <CheckCircleIcon size={16} className="mt-0.5 shrink-0"/><p>The code is active for 24 hours and can unlock an exam only during that exam’s scheduled window. Regenerating it immediately invalidates the previous code. Keep it private and enter it in the candidate’s unlock screen when the exam begins.</p>
            </div>
        </section>
    </AdminShell>;
}
