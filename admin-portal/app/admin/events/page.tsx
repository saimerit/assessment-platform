'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { fetchWithAuth } from '@/lib/api';
import { AdminShell } from '../AdminShell';
import { DateTimePicker } from '../components/DateTimePicker';
import { SelectMenu, type SelectOption } from '../components/SelectMenu';
import { CalendarIcon, CheckCircleIcon, ClipboardListIcon, DocumentAddIcon, LayersIcon, LockKeyholeIcon, UserRoundedIcon, UsersGroupRoundedIcon } from '@/lib/solar-icons';

type Bank = { id: string; name: string };
type Question = { id: string; title: string; question_type: 'MCQ' | 'FIB'; statement: string; bank_id: string; bank_name: string; options?: { id: string; text: string }[] };
type Proctor = { id: string; full_name: string; email: string };
type AssessmentEvent = { id: string; title: string; mode: string; scheduled_start: string; scheduled_end: string; duration_minutes: number };
type OrgCandidate = { id: string; full_name: string; email: string };
type CandidateLink = { candidate_name: string; email: string; invitation_url: string; temporary_password?: string };
type EventInvitee = { candidate_name: string; email: string; invitation_url: string; status: string };
type PaperMode = 'FIXED_SETS' | 'RANDOM_PER_CANDIDATE' | 'RANDOM_SETS';

const modes: SelectOption[] = [
    { value: 'ONLINE_PROCTORING', label: 'Online proctoring', description: 'Camera and microphone required' },
    { value: 'OFFLINE_NORMAL', label: 'Offline normal', description: 'Organizer announces when to begin' },
    { value: 'OFFLINE_PROCTORING', label: 'Offline proctoring', description: 'Assigned proctor enters access code' },
];

export default function AssessmentEventsPage() {
    const router = useRouter();
    const [banks, setBanks] = useState<Bank[]>([]);
    const [questions, setQuestions] = useState<Question[]>([]);
    const [proctors, setProctors] = useState<Proctor[]>([]);
    const [events, setEvents] = useState<AssessmentEvent[]>([]);
    const [orgCandidates, setOrgCandidates] = useState<OrgCandidate[]>([]);
    const [selectedEventId, setSelectedEventId] = useState('');
    const [selectedCandidateIds, setSelectedCandidateIds] = useState<string[]>([]);
    const [candidateSearch, setCandidateSearch] = useState('');
    const [activeTab, setActiveTab] = useState<'setup' | 'external' | 'internal' | 'invitees'>('setup');
    const [selectedBankIds, setSelectedBankIds] = useState<string[]>([]);
    const [selectedQuestions, setSelectedQuestions] = useState<string[]>([]);
    const [selectedProctors, setSelectedProctors] = useState<string[]>([]);
    const [paperMode, setPaperMode] = useState<PaperMode>('FIXED_SETS');
    const [randomSetCount, setRandomSetCount] = useState('4');
    const [questionCounts, setQuestionCounts] = useState<Record<string, string>>({});
    const [generatedPaperIds, setGeneratedPaperIds] = useState<string[]>([]);
    const [eventForm, setEventForm] = useState({ title: '', mode: 'ONLINE_PROCTORING', scheduled_start: '', scheduled_end: '', duration_minutes: '60', papers: 'Paper A' });
    const [candidateText, setCandidateText] = useState('');
    const [candidateLinks, setCandidateLinks] = useState<CandidateLink[]>([]);
    const [eventInvitees, setEventInvitees] = useState<EventInvitee[]>([]);
    const [inviteesSearch, setInviteesSearch] = useState('');
    const [inviteesLoading, setInviteesLoading] = useState(false);
    const [message, setMessage] = useState('');
    const [busy, setBusy] = useState(false);

    const loadSetup = async () => {
        const [bankResponse, proctorResponse, eventResponse, candidateResponse] = await Promise.all([fetchWithAuth('/admin/question-banks'), fetchWithAuth('/admin/proctors'), fetchWithAuth('/admin/assessment-events'), fetchWithAuth('/admin/candidates')]);
        if (!bankResponse.ok || !proctorResponse.ok || !eventResponse.ok || !candidateResponse.ok) throw new Error('Unable to load question banks, proctors, events, or organization candidates.');
        const [bankData, proctorData, eventData, candidateData] = await Promise.all([bankResponse.json(), proctorResponse.json(), eventResponse.json(), candidateResponse.json()]);
        setBanks(bankData.question_banks ?? []);
        setProctors(proctorData.proctors ?? []);
        const loadedEvents: AssessmentEvent[] = eventData.events ?? [];
        setEvents(loadedEvents);
        setOrgCandidates(candidateData.candidates ?? []);
        setSelectedEventId(loadedEvents[0]?.id ?? '');
    };

    useEffect(() => {
        if (!localStorage.getItem('user')) { router.push('/login'); return; }
        void loadSetup().catch((error: unknown) => setMessage(error instanceof Error ? error.message : 'Unable to load setup.'));
    }, [router]);

    const selectedBankKey = selectedBankIds.join(',');
    useEffect(() => {
        if (!selectedBankKey) { setQuestions([]); setSelectedQuestions([]); return; }
        let active = true;
        const loadBankQuestions = async () => {
            const selectedIds = selectedBankKey.split(',').filter(Boolean);
            const grouped = await Promise.all(selectedIds.map(async (bankId) => {
                const response = await fetchWithAuth(`/admin/question-banks/${bankId}/questions`);
                const data = await response.json();
                if (!response.ok) throw new Error(data.error || 'Unable to load questions.');
                const bankName = banks.find((bank) => bank.id === bankId)?.name ?? 'Question bank';
                return (data.questions ?? []).map((question: Omit<Question, 'bank_id' | 'bank_name'>) => ({ ...question, bank_id: bankId, bank_name: bankName }));
            }));
            if (active) setQuestions(grouped.flat());
        };
        void loadBankQuestions().catch((error: unknown) => { if (active) setMessage(error instanceof Error ? error.message : 'Unable to load questions.'); });
        return () => { active = false; };
    }, [selectedBankKey, banks]);

    useEffect(() => {
        if (activeTab !== 'invitees') return;
        if (!selectedEventId) { setEventInvitees([]); return; }
        let active = true;
        setInviteesLoading(true);
        fetchWithAuth(`/admin/assessment-events/${selectedEventId}/invitations`)
            .then(async (response) => {
                const data = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(data.error || 'Unable to load invited candidates.');
                if (active) setEventInvitees(data.invitations ?? []);
            })
            .catch((error: unknown) => { if (active) setMessage(error instanceof Error ? error.message : 'Unable to load invited candidates.'); })
            .finally(() => { if (active) setInviteesLoading(false); });
        return () => { active = false; };
    }, [activeTab, selectedEventId]);

    const doRequest = async (url: string, body: unknown) => {
        const response = await fetchWithAuth(url, { method: 'POST', body: JSON.stringify(body) });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'Request failed.');
        return data;
    };
    const submit = async (action: () => Promise<void>) => {
        setBusy(true); setMessage('');
        try { await action(); } catch (error) { setMessage(error instanceof Error ? error.message : 'Request failed.'); }
        finally { setBusy(false); }
    };

    const createEvent = (event: FormEvent) => {
        event.preventDefault();
        if (!selectedBankIds.length) { setMessage('Select at least one question bank.'); return; }
        if ((paperMode === 'FIXED_SETS' && !selectedQuestions.length) || !selectedProctors.length) { setMessage(paperMode === 'FIXED_SETS' ? 'Select questions and at least one proctor.' : 'Select at least one proctor.'); return; }
        const sections = selectedBankIds.map((bankId) => ({
            bank_id: bankId,
            name: banks.find((bank) => bank.id === bankId)?.name ?? 'Question bank',
            question_ids: questions.filter((question) => question.bank_id === bankId && selectedQuestions.includes(question.id)).map((question) => question.id),
        }));
        if (paperMode === 'FIXED_SETS' && sections.some((section) => section.question_ids.length === 0)) { setMessage('Select at least one question from every chosen bank section.'); return; }
        if (paperMode !== 'FIXED_SETS' && selectedBankIds.some((bankId) => { const count = Number(questionCounts[bankId] || 0); return !Number.isInteger(count) || count < 1 || count > questions.filter((question) => question.bank_id === bankId).length; })) { setMessage('Set a valid question count for every selected bank.'); return; }
        if (!eventForm.scheduled_start || !eventForm.scheduled_end || new Date(eventForm.scheduled_end) <= new Date(eventForm.scheduled_start)) { setMessage('Choose a valid start and end time. The end must be after the start.'); return; }
        void submit(async () => {
            const paperLines = eventForm.papers.split('\n').map((line) => line.trim()).filter(Boolean);
            if (paperMode === 'FIXED_SETS' && paperLines.length === 0) throw new Error('Enter at least one paper set name.');
            const data = await doRequest('/admin/assessment-events', {
                title: eventForm.title,
                mode: eventForm.mode,
                scheduled_start: new Date(eventForm.scheduled_start).toISOString(),
                scheduled_end: new Date(eventForm.scheduled_end).toISOString(),
                duration_minutes: Number(eventForm.duration_minutes),
                proctor_ids: selectedProctors,
                ...(paperMode === 'FIXED_SETS'
                    ? { papers: paperLines.map((name) => ({ name, sections })) }
                    : { papers: [], paper_generation: { mode: paperMode, set_count: paperMode === 'RANDOM_SETS' ? Number(randomSetCount) : 0, sections: selectedBankIds.map((bankId) => ({ bank_id: bankId, name: banks.find((bank) => bank.id === bankId)?.name ?? 'Question bank', question_count: Number(questionCounts[bankId]) })) } }),
            });
            setGeneratedPaperIds(data.paper_ids ?? []);
            setCandidateLinks([]);
            const created = { id: data.assessment_id, title: data.title, mode: eventForm.mode, scheduled_start: eventForm.scheduled_start, scheduled_end: eventForm.scheduled_end, duration_minutes: Number(eventForm.duration_minutes) };
            setEvents((current) => [created, ...current.filter((item) => item.id !== created.id)]);
            setSelectedEventId(created.id);
            setActiveTab('external');
            setMessage(paperMode === 'RANDOM_PER_CANDIDATE'
                ? 'Assessment event created. A fresh randomized paper will be generated privately for each candidate when assigned.'
                : paperMode === 'RANDOM_SETS'
                    ? 'Assessment event created. Candidates will be assigned to the generated randomized paper sets.'
                    : 'Assessment event created. Add candidates below to dispatch invitation links.');
        });
    };

    const inviteCandidates = () => {
        if (!selectedEventId) return;
        void submit(async () => {
            const candidates = candidateText.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
                const [full_name, email] = line.split(',').map((part) => part.trim()); return { full_name, email };
            });
            if (candidates.some((candidate) => !candidate.full_name || !candidate.email)) throw new Error('Enter one candidate per line as Full Name,email@example.com.');
            const data = await doRequest(`/admin/assessment-events/${selectedEventId}/invitations`, { candidates });
            setCandidateLinks(data.invitations ?? []);
            setMessage(`Sent ${data.invited} candidate invitation(s). Links were queued for email.`);
        });
    };
    const regenerateEventCodes = () => {
        if (!selectedEventId) return;
        void submit(async () => { await doRequest(`/admin/assessment-events/${selectedEventId}/passcodes/regenerate`, {}); setMessage('Access codes regenerated. Assigned proctors will see the updated code in their portal.'); });
    };

    const assignOrgCandidates = () => {
        if (!selectedEventId || selectedCandidateIds.length === 0) return;
        void submit(async () => {
            const data = await doRequest(`/admin/assessment-events/${selectedEventId}/assign-candidates`, { candidate_ids: selectedCandidateIds });
            setCandidateLinks(data.invitations ?? []);
            setSelectedCandidateIds([]);
            setMessage(`Assigned ${data.assigned} registered candidate(s). Exam links were queued by email.`);
        });
    };

    const eventOptions = events.map((event) => ({ value: event.id, label: event.title, description: `${event.mode.replaceAll('_', ' ')} · ${new Date(event.scheduled_start).toLocaleString()}` }));
    const visibleOrgCandidates = orgCandidates.filter((candidate) => `${candidate.full_name} ${candidate.email}`.toLowerCase().includes(candidateSearch.toLowerCase()));
    const visibleEventInvitees = eventInvitees.filter((candidate) => `${candidate.candidate_name} ${candidate.email}`.toLowerCase().includes(inviteesSearch.toLowerCase()));

    return <AdminShell title="Exam Assignment" subtitle="Create and schedule an assessment event with selected papers and proctors.">
        {message && <div role="status" className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800">{message}</div>}
        {generatedPaperIds.length > 0 && <section className="rounded-xl border border-indigo-100 bg-indigo-50/60 p-4"><h2 className="text-xs font-bold text-indigo-900">Generated reusable QP IDs</h2><p className="mb-2 mt-1 text-[10px] text-indigo-700">These IDs identify the randomized paper sets used by this event.</p><div className="grid gap-2 sm:grid-cols-2">{generatedPaperIds.map((paperId, index) => <code key={paperId} className="overflow-hidden text-ellipsis rounded-lg bg-white px-3 py-2 text-[10px] text-slate-600">QP {index + 1}: {paperId}</code>)}</div></section>}

        <nav aria-label="Exam management tasks" className="flex flex-wrap gap-2 rounded-2xl border border-slate-100 bg-white p-2 shadow-sm">
            {[{ id: 'setup', label: 'Create exam' }, { id: 'external', label: 'Invite external candidates' }, { id: 'internal', label: 'Assign organization candidates' }, { id: 'invitees', label: 'Invited candidates' }].map((tab) => <button key={tab.id} type="button" onClick={() => { setActiveTab(tab.id as typeof activeTab); setCandidateLinks([]); }} aria-current={activeTab === tab.id ? 'page' : undefined} className={`rounded-xl px-4 py-2.5 text-xs font-semibold transition ${activeTab === tab.id ? 'bg-emerald-500 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-50'}`}>{tab.label}</button>)}
        </nav>

        {activeTab === 'setup' && <>
        <section className="rounded-2xl border border-slate-100 bg-white p-4 shadow-[0_8px_30px_-22px_rgba(15,23,42,.22)] md:p-5">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-2xl bg-sky-50 text-sky-600"><LayersIcon size={21} /></span><div><h2 className="text-sm font-bold text-slate-800">Question bank sections</h2><p className="text-[11px] text-slate-400">Select one or more banks; each selected bank becomes its own exam section.</p></div></div>
                <a href="/admin/questions" className="inline-flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2.5 text-[11px] font-semibold text-emerald-700 transition hover:bg-emerald-100"><DocumentAddIcon size={16} />Create or edit questions and banks</a>
            </div>
            {banks.length > 0 ? <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{banks.map((bank) => { const checked = selectedBankIds.includes(bank.id); const count = questions.filter((question) => question.bank_id === bank.id).length; return <label key={bank.id} className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition ${checked ? 'border-indigo-200 bg-indigo-50/70' : 'border-slate-100 bg-slate-50/60 hover:border-slate-200'}`}><input type="checkbox" checked={checked} onChange={(event) => { const include = event.target.checked; setSelectedBankIds((current) => include ? [...current, bank.id] : current.filter((id) => id !== bank.id)); if (!include) { const removed = questions.filter((question) => question.bank_id === bank.id).map((question) => question.id); setSelectedQuestions((current) => current.filter((id) => !removed.includes(id))); } }} className="h-4 w-4 accent-indigo-500"/><span className="min-w-0 flex-1"><span className="block truncate text-xs font-semibold text-slate-700">{bank.name}</span><span className="text-[10px] text-slate-400">{checked ? `${count} questions loaded` : 'Select as an exam section'}</span></span>{checked && <span className="rounded-full bg-white px-2 py-1 text-[9px] font-bold text-indigo-600">SECTION</span>}</label>; })}</div> : null}
            {banks.length === 0 && <p className="mt-2 text-xs text-slate-400">No question banks found. Create a bank and add questions first.</p>}
        </section>

        <section className="rounded-2xl border border-slate-100 bg-white p-4 shadow-[0_8px_30px_-22px_rgba(15,23,42,.22)] md:p-5">
            <div className="mb-3"><h2 className="text-sm font-bold text-slate-800">Question paper generation</h2><p className="mt-1 text-[11px] text-slate-400">Keep the existing hand-picked papers, generate reusable random sets, or privately generate a new paper per candidate.</p></div>
            <div className="grid gap-2 md:grid-cols-3">
                {([
                    ['FIXED_SETS', 'Use selected questions', 'Keep your selected questions and named paper sets.'],
                    ['RANDOM_PER_CANDIDATE', 'Random paper per candidate', 'Sample the required counts when each candidate is assigned. Organizers do not see individual papers.'],
                    ['RANDOM_SETS', 'Generate reusable random sets', 'Create a chosen number of randomized QPs and assign them across candidates.'],
                ] as const).map(([value, label, description]) => <button key={value} type="button" onClick={() => setPaperMode(value)} aria-pressed={paperMode === value} className={`rounded-xl border p-3 text-left transition ${paperMode === value ? 'border-indigo-300 bg-indigo-50' : 'border-slate-100 bg-slate-50 hover:bg-white'}`}><span className="block text-xs font-bold text-slate-700">{label}</span><span className="mt-1 block text-[10px] leading-relaxed text-slate-500">{description}</span></button>)}
            </div>
            {paperMode === 'RANDOM_SETS' && <label className="mt-4 block max-w-xs text-xs font-semibold text-slate-600">Number of reusable paper sets<input type="number" min="1" max="100" value={randomSetCount} onChange={(event) => setRandomSetCount(event.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm"/></label>}
        </section>

        {selectedBankIds.length > 0 && paperMode === 'FIXED_SETS' && <section className="space-y-4 rounded-2xl border border-slate-100 bg-white p-4 shadow-[0_8px_30px_-22px_rgba(15,23,42,.22)] md:p-5">
            <div className="flex items-center justify-between gap-3"><div><h2 className="text-sm font-bold text-slate-800">Questions in selected sections</h2><p className="text-[11px] text-slate-400">Choose the questions included in each paper.</p></div><span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-semibold text-slate-500">{selectedQuestions.length} / {questions.length} selected</span></div>
            {selectedBankIds.map((bankId, sectionIndex) => { const sectionQuestions = questions.filter((question) => question.bank_id === bankId); const bank = banks.find((item) => item.id === bankId); return <div key={bankId} className="overflow-hidden rounded-xl border border-indigo-100"><div className="flex items-center justify-between gap-3 bg-indigo-50/70 px-4 py-3"><div><p className="text-[10px] font-bold uppercase tracking-wide text-indigo-600">Section {sectionIndex + 1}</p><h3 className="text-xs font-bold text-slate-800">{bank?.name}</h3></div><span className="text-[10px] text-slate-500">{sectionQuestions.filter((question) => selectedQuestions.includes(question.id)).length} selected</span></div>{sectionQuestions.length ? <div className="grid gap-2 p-3 md:grid-cols-2">{sectionQuestions.map((question) => { const checked = selectedQuestions.includes(question.id); return <label key={question.id} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition ${checked ? 'border-indigo-200 bg-indigo-50/50' : 'border-slate-100 bg-slate-50/70 hover:border-slate-200 hover:bg-white'}`}><input type="checkbox" checked={checked} onChange={(event) => setSelectedQuestions((current) => event.target.checked ? [...current, question.id] : current.filter((id) => id !== question.id))} className="mt-0.5 h-4 w-4 accent-indigo-500"/><span className="min-w-0"><span className="block text-xs font-semibold text-slate-800">{question.title}<span className="ml-2 rounded-full bg-white px-1.5 py-0.5 text-[9px] font-medium text-slate-400">{question.question_type}</span></span><span className="mt-1 block line-clamp-2 text-[11px] leading-relaxed text-slate-500">{question.statement}</span></span></label>; })}</div> : <p className="px-4 py-6 text-center text-xs text-slate-400">This bank has no questions.</p>}</div>; })}
        </section>}

        {selectedBankIds.length > 0 && paperMode !== 'FIXED_SETS' && <section className="space-y-3 rounded-2xl border border-slate-100 bg-white p-4 md:p-5"><div><h2 className="text-sm font-bold text-slate-800">Randomized question counts</h2><p className="mt-1 text-[11px] text-slate-400">Choose how many questions to sample from each selected bank for each section.</p></div>{selectedBankIds.map((bankId, index) => { const bank = banks.find((item) => item.id === bankId); const count = questions.filter((question) => question.bank_id === bankId).length; return <label key={bankId} className="grid items-center gap-2 rounded-xl border border-slate-100 bg-slate-50 p-3 sm:grid-cols-[minmax(0,1fr)_160px]"><span><span className="block text-xs font-semibold text-slate-700">Section {index + 1}: {bank?.name}</span><span className="text-[10px] text-slate-400">Question pool: {count}</span></span><input aria-label={`Questions to sample from ${bank?.name}`} type="number" min="1" max={count} value={questionCounts[bankId] ?? '1'} onChange={(event) => setQuestionCounts((current) => ({ ...current, [bankId]: event.target.value }))} className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"/></label>; })}</section>}

        <form onSubmit={createEvent} className="space-y-5 rounded-2xl border border-slate-100 bg-white p-4 shadow-[0_8px_30px_-22px_rgba(15,23,42,.22)] md:p-6">
            <div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-2xl bg-violet-50 text-violet-600"><CalendarIcon size={21} /></span><div><h2 className="text-sm font-bold text-slate-800">Create assessment event and papers</h2><p className="text-[11px] text-slate-400">Set event details, proctors, and paper sets</p></div></div>
            <label className="block text-xs font-semibold text-slate-500">Assessment / event title<input className="mt-1.5 w-full rounded-xl border border-slate-200 bg-white px-3.5 py-3 text-sm font-normal text-slate-700 outline-none transition placeholder:text-slate-400 focus:border-emerald-400 focus:ring-4 focus:ring-emerald-50" required placeholder="e.g. Data Structures Midterm Test" value={eventForm.title} onChange={(event) => setEventForm({ ...eventForm, title: event.target.value })}/></label>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <SelectMenu id="assessment-mode" label="Assessment type" value={eventForm.mode} options={modes} onChange={(mode) => setEventForm({ ...eventForm, mode })} leadingIcon={<LockKeyholeIcon size={16} />} />
                <DateTimePicker id="scheduled-start" label="Starts" value={eventForm.scheduled_start} onChange={(scheduled_start) => setEventForm({ ...eventForm, scheduled_start })} />
                <DateTimePicker id="scheduled-end" label="Ends" value={eventForm.scheduled_end} onChange={(scheduled_end) => setEventForm({ ...eventForm, scheduled_end })} />
                <label className="block text-xs font-semibold text-slate-500">Duration (minutes)<div className="mt-1.5 flex min-h-11 items-center rounded-xl border border-slate-200 bg-white shadow-sm focus-within:border-emerald-400 focus-within:ring-4 focus-within:ring-emerald-50"><input className="w-full bg-transparent px-3.5 text-sm font-normal text-slate-700 outline-none" type="number" min="1" required value={eventForm.duration_minutes} onChange={(event) => setEventForm({ ...eventForm, duration_minutes: event.target.value })}/><span className="pr-3 text-[10px] font-medium text-slate-400">min</span></div></label>
            </div>
            <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-4">
                <div className="mb-3 flex items-center justify-between gap-2"><div className="flex items-center gap-2"><UserRoundedIcon size={17} className="text-sky-600"/><div><h3 className="text-xs font-bold text-slate-700">Assign proctors</h3><p className="text-[10px] text-slate-400">Assignments rotate across the candidate list</p></div></div><span className="text-[10px] font-semibold text-slate-400">{selectedProctors.length} selected</span></div>
                {proctors.length ? <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">{proctors.map((proctor) => {
                    const checked = selectedProctors.includes(proctor.id);
                    return <label key={proctor.id} className={`flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 transition ${checked ? 'border-emerald-200 bg-emerald-50' : 'border-slate-100 bg-white hover:border-slate-200'}`}><input type="checkbox" checked={checked} onChange={(event) => setSelectedProctors((current) => event.target.checked ? [...current, proctor.id] : current.filter((id) => id !== proctor.id))} className="h-4 w-4 accent-emerald-500"/><span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-cyan-100 text-[10px] font-bold text-cyan-700">{proctor.full_name.split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase()}</span><span className="min-w-0"><span className="block truncate text-[11px] font-semibold text-slate-700">{proctor.full_name}</span><span className="block truncate text-[10px] text-slate-400">{proctor.email}</span></span>{checked && <CheckCircleIcon size={17} className="ml-auto shrink-0 text-emerald-600"/>}</label>;
                })}</div> : <p className="rounded-lg bg-white px-3 py-4 text-center text-xs text-slate-400">No proctors found. Create or invite proctors before scheduling.</p>}
            </div>
            {paperMode === 'FIXED_SETS' && <label className="block text-xs font-semibold text-slate-500">Paper set names <span className="font-normal text-slate-400">(one per line; each paper contains the selected questions)</span><textarea className="mt-1.5 w-full resize-y rounded-xl border border-slate-200 bg-white px-3.5 py-3 text-sm font-normal text-slate-700 outline-none transition placeholder:text-slate-400 focus:border-emerald-400 focus:ring-4 focus:ring-emerald-50" rows={3} value={eventForm.papers} onChange={(event) => setEventForm({ ...eventForm, papers: event.target.value })}/></label>}
            <button className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-emerald-500 to-teal-500 px-5 py-3 text-xs font-bold text-white shadow-sm shadow-emerald-200 transition hover:from-emerald-600 hover:to-teal-600 disabled:cursor-not-allowed disabled:opacity-50" disabled={busy || (paperMode === 'FIXED_SETS' && !selectedQuestions.length) || selectedBankIds.length === 0 || !selectedProctors.length}><CalendarIcon size={16}/>{busy ? 'Creating…' : 'Create event'}</button>
        </form>
        </>}

        {(activeTab === 'external' || activeTab === 'internal' || activeTab === 'invitees') && <section className="space-y-4 rounded-2xl border border-slate-100 bg-white p-4 shadow-[0_8px_30px_-22px_rgba(15,23,42,.22)] md:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3"><div className="flex items-center gap-3"><span className={`grid h-10 w-10 place-items-center rounded-2xl ${activeTab === 'external' ? 'bg-sky-50 text-sky-600' : 'bg-emerald-50 text-emerald-600'}`}><UsersGroupRoundedIcon size={20}/></span><div><h2 className="text-sm font-bold text-slate-800">{activeTab === 'external' ? 'Invite candidates outside your organization' : activeTab === 'internal' ? 'Assign an exam to organization candidates' : 'Candidates invited to an exam'}</h2><p className="max-w-2xl text-[11px] text-slate-400">{activeTab === 'external' ? 'They receive a unique exam link by email and can open the assessment directly; no organization registration is required.' : activeTab === 'internal' ? 'Choose registered candidates already listed in Candidate Management. Their exam link will be sent to their account email.' : 'Review invitees by name, email, invitation status, and exam.'}</p></div></div>{activeTab !== 'invitees' && <button type="button" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-800 transition hover:bg-amber-100 disabled:opacity-50" disabled={busy || !selectedEventId} onClick={regenerateEventCodes}>Regenerate proctor access codes</button>}</div>
            <div className="max-w-xl"><SelectMenu id="invite-event-select" label="Assessment event" value={selectedEventId} options={eventOptions} onChange={(id) => { setSelectedEventId(id); setCandidateLinks([]); }} placeholder="Choose an exam event" leadingIcon={<CalendarIcon size={16}/>}/></div>
            {!events.length && <p className="rounded-xl bg-amber-50 px-4 py-3 text-xs text-amber-800">Create an exam event in the Create exam tab before inviting or assigning candidates.</p>}
            {activeTab === 'external' && <>
                <label className="block text-xs font-semibold text-slate-600">External candidates <span className="font-normal text-slate-400">(one person per line: Full Name,email@example.com)</span><textarea className="mt-1.5 w-full rounded-xl border border-slate-200 bg-white px-3.5 py-3 text-sm text-slate-700 outline-none transition placeholder:text-slate-400 focus:border-emerald-400 focus:ring-4 focus:ring-emerald-50" rows={5} placeholder={'Alex Johnson,alex@example.com\nSarah Chen,sarah@example.com'} value={candidateText} onChange={(event) => setCandidateText(event.target.value)}/></label>
                <button type="button" className="rounded-lg bg-gradient-to-r from-sky-500 to-indigo-500 px-4 py-2.5 text-xs font-semibold text-white transition hover:from-sky-600 hover:to-indigo-600 disabled:opacity-50" disabled={busy || !selectedEventId || !candidateText.trim()} onClick={inviteCandidates}>Send exam links</button>
            </>}
            {activeTab === 'internal' && <>
                <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs font-semibold text-slate-600">Registered organization candidates ({visibleOrgCandidates.length})</p><div className="flex flex-wrap gap-2"><input className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs sm:w-64" value={candidateSearch} onChange={(event) => setCandidateSearch(event.target.value)} placeholder="Search name or email"/><button type="button" className="rounded-lg border border-slate-200 px-3 py-2 text-[11px] font-semibold text-slate-600 hover:bg-slate-50" onClick={() => setSelectedCandidateIds(visibleOrgCandidates.map((candidate) => candidate.id))}>Select visible</button></div></div>
                {visibleOrgCandidates.length ? <div className="grid max-h-[420px] gap-2 overflow-y-auto sm:grid-cols-2">{visibleOrgCandidates.map((candidate) => { const checked = selectedCandidateIds.includes(candidate.id); return <label key={candidate.id} className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 ${checked ? 'border-emerald-200 bg-emerald-50/70' : 'border-slate-100 bg-slate-50/60 hover:bg-white'}`}><input type="checkbox" checked={checked} onChange={(event) => setSelectedCandidateIds((current) => event.target.checked ? [...current, candidate.id] : current.filter((id) => id !== candidate.id))} className="h-4 w-4 accent-emerald-500"/><span className="min-w-0"><span className="block truncate text-xs font-semibold text-slate-700">{candidate.full_name}</span><span className="block truncate text-[10px] text-slate-400">{candidate.email}</span></span></label>; })}</div> : <div className="rounded-xl bg-slate-50 px-4 py-8 text-center text-xs text-slate-400">No registered candidates match. External candidates can receive direct exam links from the other tab.</div>}
                <button type="button" className="rounded-lg bg-gradient-to-r from-emerald-500 to-teal-500 px-4 py-2.5 text-xs font-semibold text-white disabled:opacity-50" disabled={busy || !selectedEventId || selectedCandidateIds.length === 0} onClick={assignOrgCandidates}>Assign exam to {selectedCandidateIds.length} candidate{selectedCandidateIds.length === 1 ? '' : 's'}</button>
            </>}
            {activeTab === 'invitees' && <>
                <div className="flex flex-wrap items-end justify-between gap-3"><p className="text-xs font-semibold text-slate-600">Invited candidates {selectedEventId ? `(${visibleEventInvitees.length})` : ''}</p><input aria-label="Search invited candidates" className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs sm:w-64" value={inviteesSearch} onChange={(event) => setInviteesSearch(event.target.value)} placeholder="Filter by name or email"/></div>
                {inviteesLoading ? <div className="rounded-xl bg-slate-50 px-4 py-8 text-center text-xs text-slate-400">Loading invitation list…</div> : visibleEventInvitees.length ? <div className="overflow-x-auto rounded-xl border border-slate-100"><table className="w-full min-w-[680px] text-left text-xs"><thead className="bg-slate-50 text-[10px] uppercase text-slate-500"><tr><th className="px-3 py-3">Candidate</th><th className="px-3 py-3">Email</th><th className="px-3 py-3">Status</th><th className="px-3 py-3">Invitation link</th></tr></thead><tbody className="divide-y divide-slate-100">{visibleEventInvitees.map((candidate) => <tr key={`${candidate.email}:${candidate.invitation_url}`}><td className="px-3 py-3 font-semibold text-slate-700">{candidate.candidate_name}</td><td className="px-3 py-3 text-slate-500">{candidate.email}</td><td className="px-3 py-3"><span className="rounded-full bg-slate-100 px-2 py-1 text-[9px] font-bold text-slate-600">{candidate.status.replaceAll('_', ' ')}</span></td><td className="max-w-sm px-3 py-3"><a className="block truncate text-sky-600 underline decoration-sky-200 underline-offset-2" href={candidate.invitation_url} target="_blank" rel="noreferrer">{candidate.invitation_url}</a></td></tr>)}</tbody></table></div> : <div className="rounded-xl bg-slate-50 px-4 py-8 text-center text-xs text-slate-400">{selectedEventId ? 'No invited candidates match this filter for the selected exam.' : 'Create an exam event before reviewing invitees.'}</div>}
            </>}
            {candidateLinks.length > 0 && <div className="overflow-x-auto rounded-xl border border-slate-100"><table className="w-full min-w-[690px] text-left text-xs"><thead className="bg-slate-50 text-[10px] uppercase text-slate-500"><tr><th className="px-3 py-3">Candidate</th><th className="px-3 py-3">Email</th><th className="px-3 py-3">Exam link</th></tr></thead><tbody className="divide-y divide-slate-100">{candidateLinks.map((candidate) => <tr key={candidate.email}><td className="px-3 py-3 font-semibold text-slate-700">{candidate.candidate_name}</td><td className="px-3 py-3 text-slate-500">{candidate.email}</td><td className="max-w-sm px-3 py-3"><a className="block truncate text-sky-600 underline decoration-sky-200 underline-offset-2" href={candidate.invitation_url} target="_blank" rel="noreferrer">{candidate.invitation_url}</a></td></tr>)}</tbody></table></div>}
        </section>}
    </AdminShell>;
}
