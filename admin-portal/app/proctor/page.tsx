'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { fetchWithAuth } from '@/lib/api';
import { BellIcon, CalendarDateIcon, ChartSquareIcon, CheckCircleIcon, ClockCircleIcon, DocumentTextIcon, LogoutIcon, LockKeyholeIcon, UsersGroupRoundedIcon } from '@/lib/solar-icons';

interface Incident { id: string; candidate_name: string; email: string; violation_type: string; reported_by: string; occurred_at: string }
interface ProctorPasscode { passcode: string; ttl_seconds: number; expires_at: string | null }
interface EventAssignment {
    assessment_id: string; title: string; mode: string; scheduled_start: string; scheduled_end: string; room_or_group: string;
    passcode?: string; ttl_seconds?: number;
    candidates?: { candidate_id: string; candidate_name: string; email: string; status: string }[];
    incidents?: { id: string; candidate_name: string; violation_type: string; occurred_at: string }[];
}

function formatDuration(totalSeconds: number): string {
    const safe = Math.max(0, totalSeconds);
    const hours = Math.floor(safe / 3600); const minutes = Math.floor((safe % 3600) / 60); const seconds = safe % 60;
    return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
}
const BLUEPRINT_ID = 'ffffffff-1111-2222-3333-444444444444';

export default function ProctorDashboard() {
    const router = useRouter();
    const [incidents, setIncidents] = useState<Incident[]>([]);
    const [loading, setLoading] = useState(true);
    const [proctorPasscode, setProctorPasscode] = useState<ProctorPasscode | null>(null);
    const [passcodeMessage, setPasscodeMessage] = useState('Loading legacy assessment passcode…');
    const [generateError, setGenerateError] = useState('');
    const [generatingCode, setGeneratingCode] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [eventAssignments, setEventAssignments] = useState<EventAssignment[]>([]);
    const [eventAssignmentsLoaded, setEventAssignmentsLoaded] = useState(false);
    const [generatingEventCodeId, setGeneratingEventCodeId] = useState<string | null>(null);
    const [eventCodeErrors, setEventCodeErrors] = useState<Record<string, string>>({});

    const generateProctorPasscode = async () => {
        setGeneratingCode(true); setGenerateError('');
        try { const response = await fetchWithAuth(`/proctor/assessments/${BLUEPRINT_ID}/passcode`, { method: 'POST' }); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Unable to generate passcode'); setProctorPasscode(data as ProctorPasscode); setPasscodeMessage(''); }
        catch (error) { setGenerateError(error instanceof Error ? error.message : 'Unable to generate passcode'); }
        finally { setGeneratingCode(false); }
    };

    const generateAssignedEventCode = async (assessmentId: string) => {
        setGeneratingEventCodeId(assessmentId); setEventCodeErrors((current) => ({ ...current, [assessmentId]: '' }));
        try {
            const response = await fetchWithAuth(`/proctor/assessment-events/${assessmentId}/passcode`, { method: 'POST' }); const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Unable to generate proctor code');
            setEventAssignments((current) => current.map((assignment) => assignment.assessment_id === assessmentId ? { ...assignment, passcode: data.passcode, ttl_seconds: data.ttl_seconds } : assignment));
        } catch (error) { setEventCodeErrors((current) => ({ ...current, [assessmentId]: error instanceof Error ? error.message : 'Unable to generate proctor code' })); }
        finally { setGeneratingEventCodeId(null); }
    };

    useEffect(() => {
        if (!localStorage.getItem('user')) { router.push('/login'); return; }
        let active = true;
        const refresh = async () => {
            try {
                const response = await fetchWithAuth(`/proctor/assessments/${BLUEPRINT_ID}/incidents`);
                if (response.ok) { const data = await response.json(); if (active) setIncidents(data.incidents || []); }
            } catch (error) { console.error('Incident polling error', error); }
            finally { if (active) setLoading(false); }
            try {
                const response = await fetchWithAuth(`/proctor/assessments/${BLUEPRINT_ID}/passcode`); const data = await response.json();
                if (!response.ok) throw new Error(data.error || 'Unable to load legacy passcode');
                if (active) { setProctorPasscode(data as ProctorPasscode); setPasscodeMessage(''); }
            } catch (error) { if (active) { setProctorPasscode(null); setPasscodeMessage(error instanceof Error ? error.message : 'No active assessment passcode'); } }
            try {
                const response = await fetchWithAuth('/proctor/assignments'); const data = await response.json();
                if (!response.ok) throw new Error(data.error || 'Unable to load event assignments');
                const assignments = (data.assignments || []) as EventAssignment[];
                const withCandidates = await Promise.all(assignments.map(async (assignment) => {
                    const [candidateResponse, incidentResponse] = await Promise.all([fetchWithAuth(`/proctor/assessment-events/${assignment.assessment_id}/candidates`), fetchWithAuth(`/proctor/assessment-events/${assignment.assessment_id}/incidents`)]);
                    const [candidateData, incidentData] = await Promise.all([candidateResponse.json(), incidentResponse.json()]);
                    return { ...assignment, candidates: candidateResponse.ok ? candidateData.candidates || [] : [], incidents: incidentResponse.ok ? incidentData.incidents || [] : [] };
                }));
                if (active) { setEventAssignments(withCandidates); setEventAssignmentsLoaded(true); }
            } catch (error) { if (active) console.error('Event assignment polling error', error); }
        };
        void refresh(); const interval = window.setInterval(() => void refresh(), 10000);
        return () => { active = false; window.clearInterval(interval); };
    }, [router]);

    useEffect(() => { setCurrentTime(Date.now()); const interval = window.setInterval(() => setCurrentTime(Date.now()), 1000); return () => window.clearInterval(interval); }, []);
    const ttlRemaining = proctorPasscode?.expires_at && currentTime > 0 ? Math.max(0, Math.ceil((Date.parse(proctorPasscode.expires_at) - currentTime) / 1000)) : null;
    const candidateCount = eventAssignments.reduce((sum, event) => sum + (event.candidates?.length ?? 0), 0);
    const incidentCount = incidents.length + eventAssignments.reduce((sum, event) => sum + (event.incidents?.length ?? 0), 0);
    const signOut = () => { localStorage.removeItem('token'); localStorage.removeItem('user'); router.push('/login'); };

    return <div className="min-h-screen bg-[#f6faf9] text-slate-800">
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b border-emerald-100 bg-white/90 px-5 backdrop-blur-xl md:px-10"><div className="flex items-center gap-2"><span className="grid h-9 w-9 place-items-center rounded-xl bg-emerald-500 text-white"><LockKeyholeIcon size={19}/></span><span className="text-sm font-extrabold">AssessPro</span><span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[9px] font-bold text-emerald-700">Proctor</span></div><div className="flex items-center gap-3"><span className="hidden items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-[10px] font-semibold text-emerald-700 sm:flex"><i className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500"/>{loading ? 'Connecting' : 'Live sync'}</span><button type="button" onClick={signOut} className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"><LogoutIcon size={15}/>Sign out</button></div></header>
        <main className="mx-auto max-w-6xl space-y-5 px-4 py-6 md:px-8">
            <div><p className="text-xs font-semibold uppercase tracking-[.18em] text-emerald-600">Invigilation workspace</p><h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-900">Proctor dashboard</h1><p className="mt-1 text-sm text-slate-500">Monitor assigned events, candidates, access codes, and reported incidents.</p></div>
            <section className="grid gap-3 sm:grid-cols-3"><article className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm"><p className="text-[11px] text-slate-500">Assigned events</p><p className="mt-1 text-2xl font-bold">{eventAssignments.length}</p></article><article className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm"><p className="text-[11px] text-slate-500">Assigned candidates</p><p className="mt-1 text-2xl font-bold">{candidateCount}</p></article><article className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm"><p className="text-[11px] text-slate-500">Reported incidents</p><p className="mt-1 text-2xl font-bold">{incidentCount}</p></article></section>

            {eventAssignmentsLoaded && eventAssignments.length === 0 && <section className="rounded-2xl border border-amber-100 bg-white p-5 shadow-sm"><div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-sm font-bold">Legacy blueprint access code</h2><p className="mt-1 text-[11px] text-slate-400">For older invitation-based blueprint assessments. Event codes appear under their assigned event.</p></div><button type="button" onClick={() => void generateProctorPasscode()} disabled={generatingCode} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-50">{generatingCode ? 'Generating…' : proctorPasscode ? 'Regenerate code' : 'Generate code'}</button></div>{generateError && <p role="alert" className="mb-3 text-xs text-rose-600">{generateError}</p>}<div className="grid gap-3 sm:grid-cols-2"><div className="rounded-xl border border-slate-100 bg-slate-50 p-4"><p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Proctor passcode</p><p className="mt-2 font-mono text-lg font-bold tracking-wider text-slate-800">{proctorPasscode?.passcode ?? passcodeMessage}</p></div><div className="rounded-xl border border-slate-100 bg-slate-50 p-4"><p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">TTL remaining</p><p className="mt-2 font-mono text-lg font-bold text-slate-800">{!proctorPasscode ? '—' : proctorPasscode.ttl_seconds < 0 ? 'No expiry' : formatDuration(ttlRemaining ?? 0)}</p></div></div></section>}

            <section className="rounded-2xl border border-slate-100 bg-white p-5 shadow-sm" aria-label="Assigned assessment events"><div className="mb-4 flex items-center gap-2"><CalendarDateIcon size={19} className="text-sky-600"/><div><h2 className="text-sm font-bold">My assigned assessment events</h2><p className="text-[10px] text-slate-400">Event access codes are restricted to the assigned proctor</p></div></div>{eventAssignments.length === 0 ? <p className="rounded-xl bg-slate-50 px-4 py-8 text-center text-xs text-slate-400">No assessment events are assigned to this proctor account.</p> : <div className="space-y-4">{eventAssignments.map((assignment) => <article key={assignment.assessment_id} className="rounded-xl border border-slate-100 bg-slate-50/50 p-4"><div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_280px]"><div><div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="text-sm font-bold text-slate-800">{assignment.title}</h3><p className="mt-1 text-[11px] text-slate-500">{assignment.mode} · {assignment.room_or_group} · {new Date(assignment.scheduled_start).toLocaleString()}</p></div><span className="rounded-full bg-sky-50 px-2.5 py-1 text-[9px] font-bold text-sky-700">{assignment.candidates?.length ?? 0} candidates</span></div>
                        <div className="mt-4 overflow-x-auto rounded-lg border border-slate-100 bg-white"><table className="w-full min-w-[440px] text-left text-xs"><thead className="bg-slate-50 text-[10px] uppercase text-slate-400"><tr><th className="px-3 py-2.5">Candidate</th><th className="px-3 py-2.5">Email</th><th className="px-3 py-2.5">Status</th></tr></thead><tbody className="divide-y divide-slate-100">{assignment.candidates?.map((candidate) => <tr key={candidate.candidate_id}><td className="px-3 py-2.5 font-semibold text-slate-700">{candidate.candidate_name}</td><td className="px-3 py-2.5 text-slate-500">{candidate.email}</td><td className="px-3 py-2.5 text-slate-500">{candidate.status}</td></tr>)}</tbody></table></div>
                        {Boolean(assignment.incidents?.length) && <div className="mt-3 rounded-lg border border-rose-100 bg-rose-50/70 p-3"><h4 className="mb-2 flex items-center gap-2 text-xs font-bold text-rose-700"><BellIcon size={14}/>Recent event incidents</h4>{assignment.incidents?.slice(0, 5).map((incident) => <p key={incident.id} className="py-0.5 text-[10px] text-rose-700">{new Date(incident.occurred_at).toLocaleTimeString()} · {incident.candidate_name} · {incident.violation_type}</p>)}</div>}</div>
                    <aside className="h-fit rounded-xl border border-amber-100 bg-gradient-to-br from-amber-50 to-white p-4"><p className="text-[10px] font-semibold uppercase tracking-wide text-amber-700">{assignment.mode === 'OFFLINE_NORMAL' ? 'Assessment access code' : 'Your proctor access code'}</p><p className="mt-2 font-mono text-xl font-bold tracking-widest text-slate-800">{assignment.passcode ?? 'No active code'}</p>{typeof assignment.ttl_seconds === 'number' && <p className="mt-1 flex items-center gap-1 text-[10px] text-slate-500"><ClockCircleIcon size={13}/>TTL {formatDuration(assignment.ttl_seconds)}</p>}<p className="mt-2 text-[10px] leading-relaxed text-slate-500">Reusable for any candidate in this event until the code expires. Enter it again for each candidate; starting one exam does not consume the code.</p><button type="button" onClick={() => void generateAssignedEventCode(assignment.assessment_id)} disabled={generatingEventCodeId === assignment.assessment_id} className="mt-3 w-full rounded-lg bg-amber-500 px-3 py-2 text-xs font-bold text-white transition hover:bg-amber-600 disabled:opacity-50">{generatingEventCodeId === assignment.assessment_id ? 'Generating…' : assignment.passcode ? 'Regenerate code' : 'Generate code'}</button>{eventCodeErrors[assignment.assessment_id] && <p role="alert" className="mt-2 text-[10px] text-rose-600">{eventCodeErrors[assignment.assessment_id]}</p>}</aside></div></article>)}</div>}</section>

            <section className="rounded-2xl border border-slate-100 bg-white p-5 shadow-sm"><div className="mb-4 flex items-center gap-2"><ChartSquareIcon size={19} className="text-violet-600"/><div><h2 className="text-sm font-bold">Detected proctoring violations</h2><p className="text-[10px] text-slate-400">Latest reports for the legacy blueprint monitor</p></div></div>{incidents.length === 0 ? <div className="grid min-h-32 place-items-center rounded-xl bg-slate-50 text-center text-xs text-slate-400"><div><CheckCircleIcon size={22} className="mx-auto mb-2 text-emerald-500"/>No active security incidents flagged.</div></div> : <div className="overflow-x-auto rounded-xl border border-slate-100"><table className="w-full min-w-[650px] text-left text-xs"><thead className="bg-slate-50 text-[10px] uppercase text-slate-500"><tr><th className="px-3 py-3">Timestamp</th><th className="px-3 py-3">Candidate</th><th className="px-3 py-3">Email</th><th className="px-3 py-3">Violation</th><th className="px-3 py-3">Origin</th></tr></thead><tbody className="divide-y divide-slate-100">{incidents.map((incident) => <tr key={incident.id}><td className="px-3 py-3 text-slate-500">{new Date(incident.occurred_at).toLocaleString()}</td><td className="px-3 py-3 font-semibold text-slate-700">{incident.candidate_name}</td><td className="px-3 py-3 text-slate-500">{incident.email}</td><td className="px-3 py-3"><span className="rounded-full bg-rose-50 px-2 py-1 text-[9px] font-bold text-rose-700">{incident.violation_type}</span></td><td className="px-3 py-3 text-slate-500">{incident.reported_by}</td></tr>)}</tbody></table></div>}</section>
        </main>
    </div>;
}
