'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { fetchWithAuth } from '@/lib/api';
import { AdminShell } from '../AdminShell';
import { SelectMenu, type SelectOption } from '../components/SelectMenu';
import { ChartSquareIcon, MagnifierIcon } from '@/lib/solar-icons';

type Result = { candidate_id: string; candidate_name: string; email: string; assessment_id: string; assessment_type: 'EVENT' | 'BLUEPRINT'; assessment_title: string; score: number; max_score: number; evaluated_at: string };
type EventOption = { id: string; title: string };

export default function ResultsPage() {
    const router = useRouter();
    const [results, setResults] = useState<Result[]>([]);
    const [events, setEvents] = useState<EventOption[]>([]);
    const [assessmentId, setAssessmentId] = useState('');
    const [candidateId, setCandidateId] = useState('');
    const [query, setQuery] = useState('');
    const [loading, setLoading] = useState(true);
    const [message, setMessage] = useState('');

    const loadResults = useCallback(async (eventId: string, selectedCandidateId: string) => {
        setLoading(true); setMessage('');
        const search = new URLSearchParams();
        if (eventId) search.set('assessment_id', eventId);
        if (selectedCandidateId) search.set('candidate_id', selectedCandidateId);
        try {
            const response = await fetchWithAuth(`/admin/results${search.size ? `?${search.toString()}` : ''}`);
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Unable to load results.');
            setResults(data.results ?? []);
        } catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to load results.'); }
        finally { setLoading(false); }
    }, []);

    useEffect(() => {
        if (!localStorage.getItem('user')) { router.push('/login'); return; }
        const params = new URLSearchParams(window.location.search);
        const requestedCandidate = params.get('candidate_id') ?? '';
        setCandidateId(requestedCandidate);
        void Promise.all([
            fetchWithAuth('/admin/assessment-events').then(async (response) => { const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Unable to load assessment events.'); setEvents(data.events ?? []); }),
            loadResults('', requestedCandidate),
        ]).catch((error: unknown) => setMessage(error instanceof Error ? error.message : 'Unable to load results.'));
    }, [router, loadResults]);

    const eventOptions: SelectOption[] = [{ value: '', label: 'All assessments' }, ...events.map((event) => ({ value: event.id, label: event.title, description: 'Assessment event' }))];
    const visible = results.filter((result) => `${result.candidate_name} ${result.email} ${result.assessment_title}`.toLowerCase().includes(query.toLowerCase()));
    const totalScore = visible.reduce((sum, result) => sum + result.score, 0);
    const totalMax = visible.reduce((sum, result) => sum + result.max_score, 0);
    const candidatesCount = new Set(visible.map((result) => result.candidate_id)).size;

    return <AdminShell title="Assessment Results" subtitle="Review event-specific candidate scores and grading status.">
        <section className="grid gap-3 sm:grid-cols-3"><article className="rounded-2xl border border-slate-100 bg-white p-4"><p className="text-[11px] text-slate-500">Graded submissions</p><p className="mt-1 text-2xl font-bold text-slate-800">{visible.length}</p></article><article className="rounded-2xl border border-slate-100 bg-white p-4"><p className="text-[11px] text-slate-500">Candidates represented</p><p className="mt-1 text-2xl font-bold text-slate-800">{candidatesCount}</p></article><article className="rounded-2xl border border-slate-100 bg-white p-4"><p className="text-[11px] text-slate-500">Points awarded / available</p><p className="mt-1 text-2xl font-bold text-slate-800">{totalScore} <span className="text-base font-semibold text-slate-400">/ {totalMax}</span></p></article></section>
        {message && <div role="status" className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800">{message}</div>}
        <section className="min-h-[350px] rounded-2xl border border-slate-100 bg-white p-4 shadow-[0_8px_30px_-22px_rgba(15,23,42,.22)] md:p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2"><span className="grid h-8 w-8 place-items-center rounded-xl bg-emerald-50 text-emerald-600"><ChartSquareIcon size={17}/></span><div><h2 className="text-sm font-bold text-slate-800">Results ({visible.length})</h2><p className="text-[10px] text-slate-400">Scores are returned per event after grading</p></div></div><div className="grid w-full gap-2 sm:w-auto sm:grid-cols-[minmax(200px,1fr)_minmax(210px,1fr)]"><label className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-slate-400"><MagnifierIcon size={15}/><input aria-label="Search candidate or assessment" className="min-w-0 bg-transparent text-xs text-slate-700 outline-none placeholder:text-slate-400" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name, email, event"/></label><SelectMenu id="results-assessment" value={assessmentId} options={eventOptions} onChange={(value) => { setAssessmentId(value); void loadResults(value, candidateId); }} placeholder="All assessments"/></div></div>
            {candidateId && <p className="mb-3 rounded-lg bg-violet-50 px-3 py-2 text-xs text-violet-700">Showing results for the selected organization candidate. <button type="button" onClick={() => { setCandidateId(''); router.replace('/admin/results'); void loadResults(assessmentId, ''); }} className="ml-1 font-semibold underline">Clear candidate filter</button></p>}
            {loading ? <p role="status" className="py-12 text-center text-xs text-slate-400">Loading graded submissions…</p> : visible.length ? <div className="overflow-x-auto rounded-xl border border-slate-100"><table className="w-full min-w-[780px] text-left text-xs"><thead className="bg-slate-50 text-[10px] font-semibold uppercase tracking-wide text-slate-500"><tr><th className="px-3 py-3">Candidate</th><th className="px-3 py-3">Email</th><th className="px-3 py-3">Assessment / event</th><th className="px-3 py-3">Score</th><th className="px-3 py-3">Graded at</th></tr></thead><tbody className="divide-y divide-slate-100">{visible.map((result) => <tr key={`${result.assessment_id}:${result.candidate_id}:${result.evaluated_at}`} className="hover:bg-slate-50/70"><td className="px-3 py-3 font-semibold text-slate-800">{result.candidate_name}</td><td className="px-3 py-3 text-slate-500">{result.email}</td><td className="px-3 py-3"><span className="block font-semibold text-slate-700">{result.assessment_title}</span><span className="text-[9px] uppercase text-slate-400">{result.assessment_type === 'EVENT' ? 'Event result' : 'Blueprint result'}</span></td><td className="px-3 py-3"><span className="rounded-full bg-emerald-50 px-2.5 py-1 font-bold text-emerald-700">{result.score} / {result.max_score}</span></td><td className="px-3 py-3 text-slate-500">{new Date(result.evaluated_at).toLocaleString()}</td></tr>)}</tbody></table></div> : <div className="grid min-h-52 place-items-center rounded-xl bg-slate-50 text-center text-xs text-slate-400">{candidateId ? 'No graded results for this candidate yet.' : 'No graded submissions match this filter.'}</div>}
        </section>
    </AdminShell>;
}
