'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { fetchWithAuth } from '@/lib/api';
import { AdminShell } from '../AdminShell';
import { ClipboardListIcon, UserPlusRoundedIcon, UsersGroupRoundedIcon } from '@/lib/solar-icons';

type Invite = { id: string; email: string; full_name: string; status: string; invited_at: string; expires_at: string; invitation_url?: string };

export default function CandidateInvitationsPage() {
    const router = useRouter();
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [invites, setInvites] = useState<Invite[]>([]);
    const [latestInvitation, setLatestInvitation] = useState<Invite | null>(null);
    const [message, setMessage] = useState('Loading organization invitations…');
    const [busy, setBusy] = useState(false);

    const loadInvites = async () => {
        const response = await fetchWithAuth('/admin/candidate-invitations');
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Unable to load invitations.');
        setInvites(data.invitations ?? []);
        setMessage('');
    };

    useEffect(() => {
        if (!localStorage.getItem('user')) { router.push('/login'); return; }
        void loadInvites().catch((error: unknown) => setMessage(error instanceof Error ? error.message : 'Unable to load invitations.'));
    }, [router]);

    const submitInvite = async (event: FormEvent) => {
        event.preventDefault();
        setBusy(true);
        setMessage('');
        try {
            const response = await fetchWithAuth('/admin/candidate-invitations', {
                method: 'POST',
                body: JSON.stringify({ candidates: [{ full_name: name.trim(), email: email.trim() }] }),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Unable to invite candidate.');
            setName('');
            setEmail('');
            setMessage(data.queued === 1 ? 'Organization invitation sent. The candidate can set a password from the email link.' : 'Invitation created, but email could not be queued. Copy the registration link below.');
            const created = data.invitations?.[0];
            if (created) { setLatestInvitation(created); setInvites((current) => [created, ...current.filter((invite) => invite.id !== created.id)]); }
            await loadInvites();
        } catch (error: unknown) {
            setMessage(error instanceof Error ? error.message : 'Unable to invite candidate.');
        } finally {
            setBusy(false);
        }
    };

    return <AdminShell title="Organization Candidate Invites" subtitle="Invite people to join your organization and register their candidate portal account. Exam invitations remain under Manage Exams.">
        {message && <div role="status" className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800">{message}</div>}
        {latestInvitation?.invitation_url && <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-800"><p className="font-semibold">Registration link for {latestInvitation.email}</p><a className="mt-1 block break-all underline underline-offset-2" href={latestInvitation.invitation_url} target="_blank" rel="noreferrer">{latestInvitation.invitation_url}</a></div>}
        <div className="grid gap-4 xl:grid-cols-[minmax(280px,.7fr)_minmax(0,1.5fr)]">
            <form onSubmit={submitInvite} className="space-y-4 rounded-2xl border border-slate-100 bg-white p-5 shadow-sm">
                <div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-2xl bg-emerald-50 text-emerald-600"><UserPlusRoundedIcon size={20}/></span><div><h2 className="text-sm font-bold text-slate-800">Invite a candidate to your organization</h2><p className="text-[11px] text-slate-400">They create their own password using a one-time link.</p></div></div>
                <label className="block text-xs font-semibold text-slate-500">Full name<input required value={name} onChange={(event) => setName(event.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-200 px-3.5 py-3 text-sm font-normal text-slate-700 outline-none focus:border-emerald-400 focus:ring-4 focus:ring-emerald-50" placeholder="e.g. Alex Johnson"/></label>
                <label className="block text-xs font-semibold text-slate-500">Email address<input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-200 px-3.5 py-3 text-sm font-normal text-slate-700 outline-none focus:border-emerald-400 focus:ring-4 focus:ring-emerald-50" placeholder="alex@example.com"/></label>
                <button disabled={busy || !name.trim() || !email.trim()} className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-emerald-500 to-teal-500 px-4 py-3 text-xs font-bold text-white shadow-sm shadow-emerald-200 disabled:opacity-50"><UserPlusRoundedIcon size={16}/>{busy ? 'Sending invitation…' : 'Send organization invitation'}</button>
                <p className="text-[10px] leading-relaxed text-slate-400">Invitation links expire after seven days. Unregistered exam invitees do not appear in Candidate Management until they complete registration.</p>
            </form>

            <section className="min-w-0 rounded-2xl border border-slate-100 bg-white p-5 shadow-sm">
                <div className="mb-4 flex items-center gap-2"><span className="grid h-8 w-8 place-items-center rounded-xl bg-sky-50 text-sky-600"><UsersGroupRoundedIcon size={17}/></span><div><h2 className="text-sm font-bold text-slate-800">Organization invitations ({invites.length})</h2><p className="text-[10px] text-slate-400">Track pending, accepted, and expired registration links.</p></div></div>
                {invites.length ? <div className="overflow-x-auto rounded-xl border border-slate-100"><table className="w-full min-w-[620px] text-left text-xs"><thead className="bg-slate-50 text-[10px] uppercase text-slate-500"><tr><th className="px-3 py-3">Candidate</th><th className="px-3 py-3">Email</th><th className="px-3 py-3">Status</th><th className="px-3 py-3">Expires</th></tr></thead><tbody className="divide-y divide-slate-100">{invites.map((invite) => <tr key={invite.id}><td className="px-3 py-3 font-semibold text-slate-700">{invite.full_name}</td><td className="px-3 py-3 text-slate-500">{invite.email}</td><td className="px-3 py-3"><span className={`rounded-full px-2 py-1 text-[9px] font-bold ${invite.status === 'ACCEPTED' ? 'bg-emerald-50 text-emerald-700' : invite.status === 'EXPIRED' ? 'bg-rose-50 text-rose-700' : 'bg-amber-50 text-amber-700'}`}>{invite.status}</span></td><td className="px-3 py-3 text-slate-500">{new Date(invite.expires_at).toLocaleString()}</td></tr>)}</tbody></table></div> : <div className="grid min-h-40 place-items-center rounded-xl bg-slate-50 text-center text-xs text-slate-400"><div><ClipboardListIcon size={22} className="mx-auto mb-2"/>No organization invitations yet.</div></div>}
            </section>
        </div>
    </AdminShell>;
}
