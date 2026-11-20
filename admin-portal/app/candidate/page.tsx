'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { fetchWithAuth } from '@/lib/api';
import { BellIcon, CalendarDateIcon, ClockCircleIcon, DocumentTextIcon, LogoutIcon, UserRoundedIcon } from '@/lib/solar-icons';

type CandidateAssessment = {
    invitation_token: string;
    assessment_id: string;
    assessment_type: 'EVENT' | 'BLUEPRINT';
    exam_title: string;
    scheduled_start: string;
    scheduled_end: string;
    status: string;
    proctoring_mode?: string | null;
};

const dayKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const formatCountdown = (target: string, now: Date) => {
    const minutes = Math.max(0, Math.floor((Date.parse(target) - now.getTime()) / 60000));
    if (minutes < 60) return `In ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `In ${hours} hr${hours === 1 ? '' : 's'}`;
    const days = Math.floor(hours / 24);
    return `In ${days} day${days === 1 ? '' : 's'}`;
};

export default function CandidatePortal() {
    const router = useRouter();
    const [assessments, setAssessments] = useState<CandidateAssessment[]>([]);
    const [message, setMessage] = useState('Loading your assessments…');
    const [now, setNow] = useState<Date | null>(null);
    const [candidateName, setCandidateName] = useState('Candidate');
    const [reminderIds, setReminderIds] = useState<string[]>([]);
    const [reminderMessage, setReminderMessage] = useState('');

    useEffect(() => {
        const userRaw = localStorage.getItem('user');
        if (!userRaw || !localStorage.getItem('token')) { router.push('/login'); return; }
        try { const user = JSON.parse(userRaw); setCandidateName(user.full_name || user.name || user.email || 'Candidate'); } catch { /* Fall back to the portal label. */ }
        try { setReminderIds(JSON.parse(localStorage.getItem('assessment-reminders') || '[]')); } catch { setReminderIds([]); }
        let active = true;
        fetchWithAuth('/candidate/assessments').then(async (response) => {
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Unable to load assigned assessments.');
            if (active) { setAssessments(data.assessments ?? []); setMessage(''); }
        }).catch((error: unknown) => { if (active) setMessage(error instanceof Error ? error.message : 'Unable to load assigned assessments.'); });
        const clock = new Date(); setNow(clock);
        const timer = window.setInterval(() => setNow(new Date()), 60000);
        return () => { active = false; window.clearInterval(timer); };
    }, [router]);

    useEffect(() => {
        if (!assessments.length || !reminderIds.length || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
        const notifyDueReminders = () => {
            let fired: string[] = [];
            try { fired = JSON.parse(localStorage.getItem('assessment-reminders-fired') || '[]'); } catch { fired = []; }
            let changed = false;
            const current = Date.now();
            for (const assessment of assessments) {
                const key = `${assessment.assessment_type}:${assessment.assessment_id}`;
                const remindAt = Date.parse(assessment.scheduled_start) - 15 * 60 * 1000;
                if (reminderIds.includes(key) && !fired.includes(key) && current >= remindAt && current < Date.parse(assessment.scheduled_end)) {
                    new Notification('Assessment starts in 15 minutes', { body: assessment.exam_title, tag: key });
                    fired.push(key); changed = true;
                }
            }
            if (changed) localStorage.setItem('assessment-reminders-fired', JSON.stringify(fired));
        };
        notifyDueReminders();
        const timer = window.setInterval(notifyDueReminders, 30000);
        return () => window.clearInterval(timer);
    }, [assessments, reminderIds]);

    const toggleReminder = async (assessment: CandidateAssessment) => {
        const key = `${assessment.assessment_type}:${assessment.assessment_id}`;
        if (reminderIds.includes(key)) {
            const next = reminderIds.filter((item) => item !== key);
            setReminderIds(next); localStorage.setItem('assessment-reminders', JSON.stringify(next));
            setReminderMessage('Reminder removed from this browser.'); return;
        }
        if (typeof Notification === 'undefined') { setReminderMessage('This browser does not support desktop notifications.'); return; }
        const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
        if (permission !== 'granted') { setReminderMessage('Allow notifications in your browser to set an assessment reminder.'); return; }
        const next = [...reminderIds, key];
        setReminderIds(next); localStorage.setItem('assessment-reminders', JSON.stringify(next));
        let fired: string[] = [];
        try { fired = JSON.parse(localStorage.getItem('assessment-reminders-fired') || '[]'); } catch { fired = []; }
        localStorage.setItem('assessment-reminders-fired', JSON.stringify(fired.filter((item) => item !== key)));
        setReminderMessage('Reminder set for 15 minutes before the assessment. Keep this browser open.');
    };

    const schedule = useMemo(() => {
        if (!now) return { dates: [] as Date[], counts: new Map<string, number>(), columns: [] as Date[][] };
        const today = startOfDay(now);
        const firstDay = new Date(today); firstDay.setDate(firstDay.getDate() - 28);
        firstDay.setDate(firstDay.getDate() - firstDay.getDay());
        const finalDay = new Date(today); finalDay.setDate(finalDay.getDate() + 153);
        const counts = new Map<string, number>();
        assessments.forEach((assessment) => { const key = dayKey(new Date(assessment.scheduled_start)); counts.set(key, (counts.get(key) ?? 0) + 1); });
        const dates: Date[] = [];
        for (let current = new Date(firstDay); current <= finalDay; current.setDate(current.getDate() + 1)) dates.push(new Date(current));
        const columns: Date[][] = [];
        for (let index = 0; index < dates.length; index += 7) columns.push(dates.slice(index, index + 7));
        return { dates, counts, columns };
    }, [assessments, now]);

    const upcoming = useMemo(() => now ? assessments.filter((assessment) => Date.parse(assessment.scheduled_end) > now.getTime() && ['INVITED', 'IN_PROGRESS'].includes(assessment.status)).sort((a, b) => Date.parse(a.scheduled_start) - Date.parse(b.scheduled_start)) : [], [assessments, now]);
    const submitted = assessments.filter((assessment) => ['SUBMITTED', 'EVALUATED'].includes(assessment.status));
    const signOut = () => { localStorage.removeItem('token'); localStorage.removeItem('user'); router.push('/login'); };

    return <div className="min-h-screen bg-[#f6faf9] text-slate-800">
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b border-emerald-100 bg-white/90 px-5 backdrop-blur-xl md:px-10"><div className="flex items-center gap-2"><span className="grid h-9 w-9 place-items-center rounded-xl bg-emerald-500 text-white"><DocumentTextIcon size={20}/></span><span className="text-sm font-extrabold">AssessPro</span><span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[9px] font-bold text-emerald-700">Candidate</span></div><div className="flex items-center gap-3"><span className="hidden text-xs font-semibold text-slate-600 sm:block">{candidateName}</span><button type="button" onClick={signOut} className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"><LogoutIcon size={15}/>Sign out</button></div></header>
        <main className="mx-auto max-w-6xl space-y-5 px-4 py-6 md:px-8">
            <div><p className="text-xs font-semibold uppercase tracking-[.18em] text-emerald-600">Candidate space</p><h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-900">Hello, {candidateName}</h1><p className="mt-1 text-sm text-slate-500">Your assigned assessments, schedule and submission records in one place.</p></div>
            <section className="grid gap-3 sm:grid-cols-3"><article className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm"><p className="text-[11px] text-slate-500">Assigned assessments</p><p className="mt-1 text-2xl font-bold">{assessments.length}</p></article><article className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm"><p className="text-[11px] text-slate-500">Upcoming tasks</p><p className="mt-1 text-2xl font-bold">{upcoming.length}</p></article><article className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm"><p className="text-[11px] text-slate-500">Completed assessments</p><p className="mt-1 text-2xl font-bold">{submitted.length}</p></article></section>
            {message && <p role="status" className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800">{message}</p>}
            <section className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(280px,.8fr)]">
                <article className="rounded-2xl border border-slate-100 bg-white p-5 shadow-sm">
                    <div className="mb-4 flex items-center justify-between"><div className="flex items-center gap-2"><CalendarDateIcon size={19} className="text-emerald-600"/><div><h2 className="text-sm font-bold">Schedule heatmap</h2><p className="text-[10px] text-slate-400">Assessment days across the past month and next five months</p></div></div><div className="flex items-center gap-1 text-[9px] text-slate-400"><span>None</span>{['bg-emerald-100', 'bg-emerald-300', 'bg-emerald-500'].map((color) => <i key={color} className={`h-2.5 w-2.5 rounded-sm ${color}`}/>)}<span>Assessments</span></div></div>
                    <div className="overflow-x-auto pb-1"><div className="flex min-w-max gap-1">{schedule.columns.map((column, columnIndex) => <div key={columnIndex} className="flex flex-col gap-1">{column.map((date) => { const count = schedule.counts.get(dayKey(date)) ?? 0; const color = count === 0 ? 'bg-slate-100' : count === 1 ? 'bg-emerald-200' : count === 2 ? 'bg-emerald-400' : 'bg-emerald-600'; return <div key={dayKey(date)} title={`${date.toLocaleDateString()}: ${count} assessment(s)`} className={`h-3 w-3 rounded-[3px] ${color}`}/>; })}</div>)}</div></div>
                    <div className="mt-2 flex justify-between text-[9px] text-slate-400"><span>{schedule.dates[0]?.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span><span>{now?.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span></div>
                </article>
                <article className="rounded-2xl border border-amber-100 bg-gradient-to-br from-amber-50 to-white p-5 shadow-sm"><div className="flex items-center gap-2 text-amber-600"><BellIcon size={19}/><h2 className="text-sm font-bold text-slate-800">Next reminder</h2></div>{upcoming[0] ? <><p className="mt-4 text-xs font-semibold text-slate-700">{upcoming[0].exam_title}</p><p className="mt-1 text-sm font-bold text-amber-700">{now ? formatCountdown(upcoming[0].scheduled_start, now) : 'Upcoming'}</p><p className="mt-2 text-[11px] text-slate-500">{new Date(upcoming[0].scheduled_start).toLocaleString()}</p><button type="button" onClick={() => void toggleReminder(upcoming[0])} className="mt-3 rounded-lg bg-white px-3 py-2 text-[10px] font-bold text-amber-800 shadow-sm transition hover:bg-amber-100">{reminderIds.includes(`${upcoming[0].assessment_type}:${upcoming[0].assessment_id}`) ? 'Reminder set · remove' : 'Set 15-minute reminder'}</button><p className="mt-2 text-[10px] leading-relaxed text-slate-500">Browser notification 15 minutes before the start; the browser needs to stay open.</p>{reminderMessage && <p role="status" className="mt-2 text-[10px] text-amber-800">{reminderMessage}</p>}</> : <p className="mt-4 text-xs text-slate-500">No upcoming assessment reminders.</p>}</article>
            </section>
            <section className="rounded-2xl border border-slate-100 bg-white p-5 shadow-sm"><div className="mb-4 flex items-center gap-2"><ClockCircleIcon size={19} className="text-sky-600"/><div><h2 className="text-sm font-bold">Assessment timeline</h2><p className="text-[10px] text-slate-400">Assigned tasks are sorted by scheduled start time</p></div></div>{assessments.length ? <div className="space-y-3">{[...assessments].sort((a, b) => Date.parse(a.scheduled_start) - Date.parse(b.scheduled_start)).map((assessment) => { const canStart = ['INVITED', 'IN_PROGRESS'].includes(assessment.status) && now && now.getTime() <= Date.parse(assessment.scheduled_end); const key = `${assessment.assessment_type}:${assessment.assessment_id}`; return <article key={key} className="grid gap-3 rounded-xl border border-slate-100 bg-slate-50/50 p-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center"><div className="flex items-start gap-3"><span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-sky-50 text-sky-600"><DocumentTextIcon size={19}/></span><div className="min-w-0"><h3 className="truncate text-sm font-bold text-slate-800">{assessment.exam_title}</h3><p className="mt-1 text-[10px] text-slate-500">{new Date(assessment.scheduled_start).toLocaleString()} · {assessment.proctoring_mode ?? 'Invitation assessment'}</p><p className="mt-1 text-[10px] font-semibold text-slate-400">{assessment.status === 'EVALUATED' ? 'SUBMITTED' : assessment.status.replaceAll('_', ' ')}</p></div></div><div className="flex flex-wrap items-center gap-2 md:justify-end">{canStart && <a href={`/exg/${encodeURIComponent(assessment.invitation_token)}`} className="rounded-lg bg-emerald-500 px-4 py-2.5 text-center text-xs font-bold text-white transition hover:bg-emerald-600">{assessment.status === 'IN_PROGRESS' ? 'Resume assessment' : 'Open assessment'}</a>}{Date.parse(assessment.scheduled_end) > (now?.getTime() ?? 0) && <button type="button" onClick={() => void toggleReminder(assessment)} className="rounded-lg border border-amber-200 bg-white px-3 py-2.5 text-[10px] font-bold text-amber-800 hover:bg-amber-50">{reminderIds.includes(key) ? 'Reminder set' : 'Remind me'}</button>}{!canStart && <span className="rounded-lg bg-white px-3 py-2 text-[10px] font-semibold text-slate-500">{['SUBMITTED', 'EVALUATED'].includes(assessment.status) ? 'Submitted' : 'Scheduled'}</span>}</div></article>; })}</div> : !message && <div className="rounded-xl bg-slate-50 px-4 py-10 text-center text-xs text-slate-400"><UserRoundedIcon size={22} className="mx-auto mb-2"/>No assigned assessments yet.</div>}</section>
        </main>
    </div>;
}
