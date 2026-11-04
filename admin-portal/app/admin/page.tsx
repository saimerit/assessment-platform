'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { fetchWithAuth } from '@/lib/api';
import { AdminShell } from './AdminShell';
import { ChartSquareIcon, ClipboardListIcon, LayersIcon, UserPlusRoundedIcon, UsersGroupRoundedIcon } from '@/lib/solar-icons';

type AssessmentEvent = { id: string; title: string; scheduled_start: string; mode: string };

const actions = [
    { href: '/admin/events', title: 'Manage exams and invite candidates', description: 'Create an assessment event, assign proctors and papers, then send exam links.', Icon: ClipboardListIcon, tone: 'sky' },
    { href: '/admin/candidate-invitations', title: 'Invite candidates to your organization', description: 'Send an organization registration link to a person who has not registered yet.', Icon: UserPlusRoundedIcon, tone: 'emerald' },
    { href: '/admin/questions', title: 'Question banks and papers', description: 'Create banks and author questions for upcoming assessment events.', Icon: LayersIcon, tone: 'violet' },
    { href: '/admin/candidates', title: 'Registered candidate management', description: 'Find registered candidates and open their event-specific results.', Icon: UsersGroupRoundedIcon, tone: 'orange' },
];

export default function AdminDashboard() {
    const router = useRouter();
    const [events, setEvents] = useState<AssessmentEvent[]>([]);
    const [message, setMessage] = useState('Loading assessment events…');

    useEffect(() => {
        if (!localStorage.getItem('user')) { router.push('/login'); return; }
        let active = true;
        fetchWithAuth('/admin/assessment-events')
            .then(async (response) => {
                const data = await response.json();
                if (!response.ok) throw new Error(data.error || 'Unable to load assessment events.');
                if (active) { setEvents(data.events ?? []); setMessage(''); }
            })
            .catch((error: unknown) => { if (active) setMessage(error instanceof Error ? error.message : 'Unable to load assessment events.'); });
        return () => { active = false; };
    }, [router]);

    return <AdminShell title="Assessment Campaign Console" subtitle="Manage organization access separately from exam assignments and candidate links.">
        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <article className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm"><p className="text-[11px] text-slate-500">Assessment events</p><p className="mt-1 text-2xl font-bold text-slate-800">{events.length}</p><p className="text-[10px] text-slate-400">Created for your organization</p></article>
            <article className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm"><p className="text-[11px] text-slate-500">Upcoming assessments</p><p className="mt-1 text-2xl font-bold text-slate-800">{events.filter((event) => Date.parse(event.scheduled_start) > Date.now()).length}</p><p className="text-[10px] text-slate-400">Candidate exam links are managed on each event</p></article>
            <Link href="/admin/results" className="flex items-center gap-3 rounded-2xl border border-slate-100 bg-white p-4 shadow-sm transition hover:border-emerald-200"><span className="grid h-10 w-10 place-items-center rounded-xl bg-violet-50 text-violet-600"><ChartSquareIcon size={20}/></span><span><span className="block text-[11px] text-slate-500">Grading and results</span><span className="block text-sm font-bold text-slate-800">Open results</span></span></Link>
        </section>
        {message && <p role="status" className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-xs text-sky-800">{message}</p>}
        <section className="grid gap-3 md:grid-cols-2">
            {actions.map(({ href, title, description, Icon, tone }) => <Link key={href} href={href} className={`flex gap-3 rounded-2xl border bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md ${tone === 'sky' ? 'border-sky-100 hover:border-sky-200' : tone === 'emerald' ? 'border-emerald-100 hover:border-emerald-200' : tone === 'violet' ? 'border-violet-100 hover:border-violet-200' : 'border-orange-100 hover:border-orange-200'}`}><span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${tone === 'sky' ? 'bg-sky-50 text-sky-600' : tone === 'emerald' ? 'bg-emerald-50 text-emerald-600' : tone === 'violet' ? 'bg-violet-50 text-violet-600' : 'bg-orange-50 text-orange-600'}`}><Icon size={20}/></span><span><span className="block text-sm font-bold text-slate-800">{title}</span><span className="mt-1 block text-xs leading-relaxed text-slate-500">{description}</span></span></Link>)}
        </section>
        <section className="rounded-2xl border border-slate-100 bg-white p-5 shadow-sm"><div className="mb-3 flex items-center justify-between gap-3"><div><h2 className="text-sm font-bold text-slate-800">Upcoming assessment events</h2><p className="mt-1 text-[10px] text-slate-400">Invite candidates for a specific exam from Manage Exams.</p></div><Link href="/admin/events" className="rounded-lg bg-emerald-500 px-3 py-2 text-[11px] font-bold text-white hover:bg-emerald-600">Manage exams</Link></div>{events.length ? <div className="divide-y divide-slate-100">{[...events].sort((a, b) => Date.parse(a.scheduled_start) - Date.parse(b.scheduled_start)).slice(0, 5).map((event) => <div key={event.id} className="flex flex-wrap items-center justify-between gap-2 py-3"><span className="text-xs font-semibold text-slate-700">{event.title}</span><span className="text-[10px] text-slate-500">{event.mode} · {new Date(event.scheduled_start).toLocaleString()}</span></div>)}</div> : !message && <p className="rounded-xl bg-slate-50 px-4 py-8 text-center text-xs text-slate-400">No events created yet. Start in Manage Exams.</p>}</section>
    </AdminShell>;
}
