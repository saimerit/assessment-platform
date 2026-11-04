'use client';

import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { useParams, useRouter } from 'next/navigation';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8081/api';
type Invitation = { email: string; full_name: string; organization: string; expires_at: string };

export default function CandidateRegistrationPage() {
    return <Suspense fallback={<main className="grid min-h-screen place-items-center bg-emerald-50 text-sm text-slate-500">Loading invitation…</main>}><CandidateRegistrationForm/></Suspense>;
}

function CandidateRegistrationForm() {
    const params = useParams<{ token: string }>();
    const router = useRouter();
    const [invitation, setInvitation] = useState<Invitation | null>(null);
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [message, setMessage] = useState('Checking invitation…');
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        let active = true;
        fetch(`${API_BASE}/auth/candidate-invitations/${encodeURIComponent(params.token)}`)
            .then(async (response) => {
                const data = await response.json();
                if (!response.ok) throw new Error(data.error || 'Invitation is not valid.');
                if (active) { setInvitation(data); setMessage(''); }
            })
            .catch((error: unknown) => { if (active) setMessage(error instanceof Error ? error.message : 'Invitation is not valid.'); });
        return () => { active = false; };
    }, [params.token]);

    const register = async (event: FormEvent) => {
        event.preventDefault();
        if (password !== confirmPassword) { setMessage('The passwords do not match.'); return; }
        setBusy(true);
        setMessage('');
        try {
            const response = await fetch(`${API_BASE}/auth/candidate-invitations/${encodeURIComponent(params.token)}/register`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Registration failed.');
            localStorage.setItem('token', data.token);
            localStorage.setItem('user', JSON.stringify(data.user));
            router.replace('/candidate');
        } catch (error: unknown) {
            setMessage(error instanceof Error ? error.message : 'Registration failed.');
        } finally {
            setBusy(false);
        }
    };

    return <main className="grid min-h-screen place-items-center bg-gradient-to-br from-emerald-50 via-white to-sky-50 p-4 text-slate-800"><section className="w-full max-w-md rounded-2xl border border-slate-100 bg-white p-7 shadow-xl shadow-slate-200/60"><div className="mb-6 text-center"><span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-emerald-500 text-lg font-black text-white">A</span><h1 className="mt-4 text-xl font-bold">Join {invitation?.organization || 'your organization'}</h1><p className="mt-1 text-xs text-slate-500">Create your candidate portal password.</p></div>
        {message && <p role="status" className="mb-4 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2.5 text-xs text-sky-800">{message}</p>}
        {invitation && <form onSubmit={register} className="space-y-4"><div className="rounded-xl bg-slate-50 p-3 text-xs"><p className="font-semibold text-slate-700">{invitation.full_name}</p><p className="mt-1 text-slate-500">{invitation.email}</p></div><label className="block text-xs font-semibold text-slate-600">Create password<input type="password" minLength={10} required autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-200 px-3.5 py-3 text-sm font-normal outline-none focus:border-emerald-400 focus:ring-4 focus:ring-emerald-50" placeholder="At least 10 characters"/></label><label className="block text-xs font-semibold text-slate-600">Confirm password<input type="password" minLength={10} required autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-200 px-3.5 py-3 text-sm font-normal outline-none focus:border-emerald-400 focus:ring-4 focus:ring-emerald-50"/></label><button disabled={busy} className="w-full rounded-xl bg-emerald-500 px-4 py-3 text-sm font-bold text-white transition hover:bg-emerald-600 disabled:opacity-50">{busy ? 'Creating account…' : 'Register and open candidate portal'}</button><p className="text-center text-[10px] text-slate-400">Password must contain at least 10 characters.</p></form>}
    </section></main>;
}
