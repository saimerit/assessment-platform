'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { fetchWithAuth } from '@/lib/api';
import { AdminShell } from '../AdminShell';
import { MagnifierIcon, UserPlusRoundedIcon, UsersGroupRoundedIcon } from '@/lib/solar-icons';

type Candidate = { id: string; full_name: string; email: string; created_at: string; blueprint_invitations: number; event_invitations: number };

export default function CandidatesPage() {
    const router = useRouter();
    const [candidates, setCandidates] = useState<Candidate[]>([]);
    const [query, setQuery] = useState('');
    const [message, setMessage] = useState('Loading candidates…');
    useEffect(() => {
        if (!localStorage.getItem('user')) { router.push('/login'); return; }
        let active = true;
        fetchWithAuth('/admin/candidates').then(async (response) => { const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Unable to load candidates.'); if (!active) return; setCandidates(data.candidates ?? []); setMessage(''); }).catch((error: unknown) => { if (active) setMessage(error instanceof Error ? error.message : 'Unable to load candidates.'); });
        return () => { active = false; };
    }, [router]);
    const visible = candidates.filter((candidate) => `${candidate.full_name} ${candidate.email}`.toLowerCase().includes(query.toLowerCase()));
    const eventInvites = candidates.reduce((sum, candidate) => sum + candidate.event_invitations, 0);
    const blueprintInvites = candidates.reduce((sum, candidate) => sum + candidate.blueprint_invitations, 0);

    return <AdminShell title="Candidate Management" subtitle="Registered candidate accounts in your organization. Invite unregistered people separately before they can create portal access.">
        <section className="grid gap-3 sm:grid-cols-3"><article className="rounded-2xl border border-slate-100 bg-white p-4"><p className="text-[11px] text-slate-500">Registered candidates</p><p className="mt-1 text-2xl font-bold text-slate-800">{candidates.length}</p></article><article className="rounded-2xl border border-slate-100 bg-white p-4"><p className="text-[11px] text-slate-500">Event invitations</p><p className="mt-1 text-2xl font-bold text-slate-800">{eventInvites}</p></article><article className="rounded-2xl border border-slate-100 bg-white p-4"><p className="text-[11px] text-slate-500">Blueprint invitations</p><p className="mt-1 text-2xl font-bold text-slate-800">{blueprintInvites}</p></article></section>
        {message && <div role="status" className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800">{message}</div>}
        <section className="min-w-0 rounded-2xl border border-slate-100 bg-white p-4 shadow-[0_8px_30px_-22px_rgba(15,23,42,.22)] md:p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h2 className="flex items-center gap-2 text-sm font-bold text-slate-800"><span className="grid h-8 w-8 place-items-center rounded-xl bg-emerald-50 text-emerald-600"><UsersGroupRoundedIcon size={17}/></span>Registered candidates ({visible.length})</h2><div className="flex w-full flex-wrap gap-2 sm:w-auto"><label className="flex min-w-52 flex-1 items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-slate-400 sm:flex-none"><MagnifierIcon size={15}/><input aria-label="Search candidates by name or email" className="min-w-0 bg-transparent text-xs text-slate-700 outline-none placeholder:text-slate-400" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name or email"/></label><Link href="/admin/candidate-invitations" className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-emerald-500 to-teal-500 px-3 py-2.5 text-xs font-bold text-white shadow-sm shadow-emerald-200"><UserPlusRoundedIcon size={15}/>Invite to organization</Link></div></div>
            {visible.length ? <div className="overflow-x-auto rounded-xl border border-slate-100"><table className="w-full min-w-[760px] text-left text-xs"><thead className="bg-slate-50 text-[10px] font-semibold uppercase tracking-wide text-slate-500"><tr><th className="px-3 py-3">Candidate</th><th className="px-3 py-3">Email</th><th className="px-3 py-3">Blueprint invites</th><th className="px-3 py-3">Event invites</th><th className="px-3 py-3">Account created</th><th className="px-3 py-3">Results</th></tr></thead><tbody className="divide-y divide-slate-100">{visible.map((candidate) => <tr key={candidate.id} className="hover:bg-slate-50/70"><td className="px-3 py-3 font-semibold text-slate-800">{candidate.full_name}</td><td className="px-3 py-3 text-slate-500">{candidate.email}</td><td className="px-3 py-3 text-slate-600">{candidate.blueprint_invitations}</td><td className="px-3 py-3 text-slate-600">{candidate.event_invitations}</td><td className="px-3 py-3 text-slate-500">{new Date(candidate.created_at).toLocaleDateString()}</td><td className="px-3 py-3"><Link href={`/admin/results?candidate_id=${encodeURIComponent(candidate.id)}`} className="font-semibold text-emerald-700 hover:text-emerald-800">View candidate results</Link></td></tr>)}</tbody></table></div> : !message && <div className="grid min-h-40 place-items-center rounded-xl bg-slate-50 text-center text-xs text-slate-400">No registered candidates match this search.</div>}
        </section>
    </AdminShell>;
}
