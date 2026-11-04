'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { fetchWithAuth } from '@/lib/api';
import { AdminShell } from '../AdminShell';
import { AddCircleIcon, UserPlusRoundedIcon, UsersGroupRoundedIcon } from '@/lib/solar-icons';

type Proctor = { id: string; full_name: string; email: string; role?: string };
const input = 'w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-700 outline-none transition placeholder:text-slate-400 focus:border-emerald-400 focus:ring-4 focus:ring-emerald-50';

export default function ProctorsPage() {
    const router = useRouter();
    const [proctors, setProctors] = useState<Proctor[]>([]);
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [query, setQuery] = useState('');
    const [message, setMessage] = useState('');
    const [busy, setBusy] = useState(false);
    const load = async () => { const response = await fetchWithAuth('/admin/proctors'); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Unable to load proctors.'); setProctors(data.proctors ?? []); };
    useEffect(() => { if (!localStorage.getItem('user')) { router.push('/login'); return; } void load().catch((error: unknown) => setMessage(error instanceof Error ? error.message : 'Unable to load proctors.')); }, [router]);
    const create = (event: FormEvent) => {
        event.preventDefault(); setBusy(true); setMessage('');
        void (async () => { try {
            const response = await fetchWithAuth('/admin/proctors', { method: 'POST', body: JSON.stringify({ full_name: name.trim(), email: email.trim() }) });
            const data = await response.json(); if (!response.ok) throw new Error(data.error || `Request failed (HTTP ${response.status}).`);
            await load(); setName(''); setEmail('');
            setMessage(data.invite_sent === false ? 'Proctor account created, but the invitation email could not be queued.' : 'Proctor created and invitation queued.');
        } catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to create proctor.'); }
        finally { setBusy(false); } })();
    };
    const visible = proctors.filter((proctor) => `${proctor.full_name} ${proctor.email}`.toLowerCase().includes(query.toLowerCase()));

    return <AdminShell title="Proctors" subtitle="Create proctor accounts and assign them to assessment events.">
        {message && <div role="status" className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800">{message}</div>}
        <section className="grid gap-4 xl:grid-cols-[minmax(280px,.72fr)_minmax(0,1.65fr)]">
            <form onSubmit={create} className="rounded-2xl border border-slate-100 bg-white p-5 shadow-[0_8px_30px_-22px_rgba(15,23,42,.22)]">
                <h2 className="mb-4 flex items-center gap-2 text-sm font-bold text-slate-800"><span className="grid h-8 w-8 place-items-center rounded-xl bg-emerald-50 text-emerald-600"><UserPlusRoundedIcon size={17}/></span>Create proctor account</h2>
                <div className="space-y-3"><label className="block text-[11px] font-semibold text-slate-500">Full name<input className={`${input} mt-1.5 font-normal`} required placeholder="e.g. Alex Johnson" value={name} onChange={(event) => setName(event.target.value)}/></label><label className="block text-[11px] font-semibold text-slate-500">Email address<input className={`${input} mt-1.5 font-normal`} required type="email" placeholder="proctor@domain.com" value={email} onChange={(event) => setEmail(event.target.value)}/></label><button className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-emerald-500 to-teal-500 px-4 py-2.5 text-xs font-bold text-white shadow-sm shadow-emerald-200 transition hover:from-emerald-600 hover:to-teal-600 disabled:opacity-50" disabled={busy || !name.trim() || !email.trim()}><AddCircleIcon size={16}/>{busy ? 'Creating…' : 'Create and invite proctor'}</button><p className="text-[10px] leading-relaxed text-slate-400">A temporary sign-in credential is sent through the local notification worker.</p></div>
            </form>
            <section className="min-w-0 rounded-2xl border border-slate-100 bg-white p-5 shadow-[0_8px_30px_-22px_rgba(15,23,42,.22)]">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h2 className="flex items-center gap-2 text-sm font-bold text-slate-800"><span className="grid h-8 w-8 place-items-center rounded-xl bg-sky-50 text-sky-600"><UsersGroupRoundedIcon size={17}/></span>Organization proctors ({visible.length})</h2><input aria-label="Search proctors" className="w-full max-w-56 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 outline-none focus:border-emerald-400" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name or email"/></div>
                {visible.length ? <div className="overflow-x-auto rounded-xl border border-slate-100"><table className="w-full min-w-[520px] text-left text-xs"><thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500"><tr><th className="px-3 py-3">Name</th><th className="px-3 py-3">Email</th><th className="px-3 py-3">Role</th><th className="px-3 py-3">Status</th></tr></thead><tbody className="divide-y divide-slate-100">{visible.map((proctor) => <tr key={proctor.id}><td className="px-3 py-3 font-semibold text-slate-800">{proctor.full_name}</td><td className="px-3 py-3 text-slate-500">{proctor.email}</td><td className="px-3 py-3 text-slate-500">{proctor.role ?? 'INVIGILATOR_PROCTOR'}</td><td className="px-3 py-3"><span className="rounded-full bg-emerald-50 px-2 py-1 text-[9px] font-bold text-emerald-700">Available</span></td></tr>)}</tbody></table></div> : <div className="grid min-h-40 place-items-center rounded-xl bg-slate-50 text-center text-xs text-slate-400">{proctors.length ? 'No proctors match this search.' : 'No proctors have been created yet.'}</div>}
            </section>
        </section>
    </AdminShell>;
}
