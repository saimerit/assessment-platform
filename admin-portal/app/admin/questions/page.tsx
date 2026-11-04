'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { fetchWithAuth } from '@/lib/api';
import { AdminShell } from '../AdminShell';
import { SelectMenu } from '../components/SelectMenu';
import { AddCircleIcon, DocumentTextIcon, LayersIcon } from '@/lib/solar-icons';

type Bank = { id: string; name: string };
type Question = { id: string; title: string; question_type: string; statement: string; marks: number };
type QuestionDraft = { title: string; statement: string; type: 'MCQ' | 'FIB'; difficulty: string; marks: string; options: string[]; correct: number[]; expected: string };
const createDraft = (): QuestionDraft => ({ title: '', statement: '', type: 'MCQ', difficulty: 'MEDIUM', marks: '1', options: ['', '', ''], correct: [], expected: '' });
const input = 'w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-700 outline-none transition placeholder:text-slate-400 focus:border-emerald-400 focus:ring-4 focus:ring-emerald-50';
const button = 'inline-flex items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-emerald-500 to-teal-500 px-4 py-2.5 text-xs font-bold text-white shadow-sm shadow-emerald-200 transition hover:from-emerald-600 hover:to-teal-600 disabled:cursor-not-allowed disabled:opacity-50';

export default function QuestionsPage() {
    const router = useRouter();
    const [banks, setBanks] = useState<Bank[]>([]);
    const [questions, setQuestions] = useState<Question[]>([]);
    const [bankId, setBankId] = useState('');
    const [bankName, setBankName] = useState('');
    const [questionCount, setQuestionCount] = useState('1');
    const [drafts, setDrafts] = useState<QuestionDraft[]>([createDraft()]);
    const [message, setMessage] = useState('');
    const [busy, setBusy] = useState(false);

    const loadBanks = async () => {
        const response = await fetchWithAuth('/admin/question-banks');
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Unable to load question banks.');
        setBanks(data.question_banks ?? []);
    };
    useEffect(() => {
        if (!localStorage.getItem('user')) { router.push('/login'); return; }
        void loadBanks().catch((error: unknown) => setMessage(error instanceof Error ? error.message : 'Unable to load banks.'));
    }, [router]);
    useEffect(() => {
        if (!bankId) { setQuestions([]); return; }
        let active = true;
        fetchWithAuth(`/admin/question-banks/${bankId}/questions`).then(async (response) => {
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Unable to load questions.');
            if (active) setQuestions(data.questions ?? []);
        }).catch((error: unknown) => { if (active) setMessage(error instanceof Error ? error.message : 'Unable to load questions.'); });
        return () => { active = false; };
    }, [bankId]);

    const request = async (path: string, body: unknown) => {
        const response = await fetchWithAuth(path, { method: 'POST', body: JSON.stringify(body) });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `Request failed (HTTP ${response.status}).`);
        return data;
    };
    const run = async (operation: () => Promise<void>) => {
        setBusy(true); setMessage('');
        try { await operation(); } catch (error) { setMessage(error instanceof Error ? error.message : 'Request failed.'); }
        finally { setBusy(false); }
    };
    const createBank = (event: FormEvent) => {
        event.preventDefault();
        void run(async () => { const data = await request('/admin/question-banks', { name: bankName.trim() }); setBanks((items) => [...items, data]); setBankId(data.id); setBankName(''); setMessage('Question bank created.'); });
    };
    const createQuestion = (event: FormEvent) => {
        event.preventDefault();
        if (!bankId) { setMessage('Select a question bank first.'); return; }
        const incomplete = drafts.findIndex((draft) => !draft.title.trim() || !draft.statement.trim() || (draft.type === 'MCQ' && (draft.options.some((option) => !option.trim()) || draft.correct.length === 0)) || (draft.type === 'FIB' && !draft.expected.trim()));
        if (incomplete >= 0) { setMessage(`Complete the title, prompt, and correct answer for question ${incomplete + 1}.`); return; }
        void run(async () => {
            const payload = { bank_id: bankId, questions: drafts.map((draft) => ({ title: draft.title.trim(), statement: draft.statement.trim(), question_type: draft.type, difficulty: draft.difficulty, marks: Number(draft.marks), options: draft.type === 'MCQ' ? draft.options.map((text, index) => ({ text: text.trim(), is_correct: draft.correct.includes(index) })) : [], expected_answer: draft.expected.trim() })) };
            await request('/admin/questions/bulk', payload);
            const response = await fetchWithAuth(`/admin/question-banks/${bankId}/questions`);
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Question saved but could not refresh the list.');
            setQuestions(data.questions ?? []);
            setDrafts(Array.from({ length: Number(questionCount) }, () => createDraft()));
            setMessage(`${drafts.length} question${drafts.length === 1 ? '' : 's'} saved. Answer keys are stored in the grading vault.`);
        });
    };
    const resizeDrafts = (value: string) => {
        setQuestionCount(value);
        const count = Math.max(1, Math.min(50, Number(value) || 1));
        setDrafts((current) => Array.from({ length: count }, (_, index) => current[index] ?? createDraft()));
    };
    const updateDraft = (index: number, update: Partial<QuestionDraft>) => setDrafts((current) => current.map((draft, draftIndex) => draftIndex === index ? { ...draft, ...update } : draft));

    return <AdminShell title="Question Banks & Papers" subtitle="Create question banks and author MCQ or fill-in-the-blank questions.">
        {message && <div role="status" className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800">{message}</div>}
        <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,1fr)]">
            <form onSubmit={createBank} className="rounded-2xl border border-slate-100 bg-white p-5 shadow-[0_8px_30px_-22px_rgba(15,23,42,.22)]">
                <h2 className="mb-4 flex items-center gap-2 text-sm font-bold text-slate-800"><span className="grid h-8 w-8 place-items-center rounded-xl bg-sky-50 text-sky-600"><LayersIcon size={17}/></span>Create or choose a bank</h2>
                <div className="flex flex-col gap-2 sm:flex-row"><input className={input} required value={bankName} onChange={(event) => setBankName(event.target.value)} placeholder="Question bank name"/><button className={`${button} shrink-0`} disabled={busy || !bankName.trim()}><AddCircleIcon size={16}/>Create bank</button></div>
                <div className="mt-3"><SelectMenu id="question-bank-select" value={bankId} onChange={setBankId} options={banks.map((bank) => ({ value: bank.id, label: bank.name }))} placeholder="Choose a bank" leadingIcon={<LayersIcon size={16}/>}/></div>
            </form>
            <section className="min-h-[170px] rounded-2xl border border-slate-100 bg-white p-5 shadow-[0_8px_30px_-22px_rgba(15,23,42,.22)]">
                <h2 className="mb-3 flex items-center gap-2 text-sm font-bold text-slate-800"><span className="grid h-8 w-8 place-items-center rounded-xl bg-emerald-50 text-emerald-600"><DocumentTextIcon size={17}/></span>Questions in selected bank ({questions.length})</h2>
                {questions.length ? <ul className="max-h-56 space-y-2 overflow-y-auto">{questions.map((question) => <li key={question.id} className="rounded-xl border border-slate-100 bg-slate-50/70 p-3 text-xs"><b className="text-slate-700">{question.title}</b><span className="ml-2 text-[10px] text-slate-400">{question.question_type} · {question.marks} marks</span><p className="mt-1 text-slate-500">{question.statement}</p></li>)}</ul> : <div className="grid h-24 place-items-center rounded-xl bg-slate-50 text-center text-xs text-slate-400">Select a bank to view its questions.</div>}
            </section>
        </section>
        <form onSubmit={createQuestion} className="space-y-4 rounded-2xl border border-slate-100 bg-white p-5 shadow-[0_8px_30px_-22px_rgba(15,23,42,.22)] md:p-6">
            <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="flex items-center gap-2 text-sm font-bold text-slate-800"><span className="grid h-8 w-8 place-items-center rounded-xl bg-emerald-50 text-emerald-600"><AddCircleIcon size={17}/></span>Create questions</h2><p className="ml-10 mt-1 text-[11px] text-slate-400">Enter a batch and save it to the selected question bank.</p></div><label className="flex items-center gap-2 text-xs font-semibold text-slate-500">Questions to add<input aria-label="Number of questions to add" className={`${input} w-24`} type="number" min="1" max="50" value={questionCount} onChange={(event) => resizeDrafts(event.target.value)} /></label></div>
            {drafts.map((draft, questionIndex) => <section key={questionIndex} className="space-y-3 rounded-xl border border-slate-100 bg-slate-50/60 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-xs font-bold text-slate-700">Question {questionIndex + 1}</h3><div className="grid w-full gap-3 sm:w-auto sm:grid-cols-2"><SelectMenu id={`question-${questionIndex}-type`} label="Question type" value={draft.type} onChange={(type) => updateDraft(questionIndex, { type: type as 'MCQ' | 'FIB' })} options={[{ value: 'MCQ', label: 'Multiple choice' }, { value: 'FIB', label: 'Fill in the blank' }]}/><SelectMenu id={`question-${questionIndex}-difficulty`} label="Difficulty" value={draft.difficulty} onChange={(difficulty) => updateDraft(questionIndex, { difficulty })} options={['EASY', 'MEDIUM', 'HARD'].map((difficulty) => ({ value: difficulty, label: difficulty }))}/></div></div>
                <label className="block text-[11px] font-semibold text-slate-500">Title<input className={`${input} mt-1.5 font-normal`} required placeholder="Short question title" value={draft.title} onChange={(event) => updateDraft(questionIndex, { title: event.target.value })}/></label>
                <label className="block text-[11px] font-semibold text-slate-500">Question prompt<textarea className={`${input} mt-1.5 font-normal`} required rows={2} placeholder="Enter the question prompt…" value={draft.statement} onChange={(event) => updateDraft(questionIndex, { statement: event.target.value })}/></label>
                {draft.type === 'MCQ' ? <div className="space-y-2"><div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-[11px] font-semibold text-slate-600">Answer options</p><p className="text-[10px] text-slate-400">Mark every correct answer. Candidates must avoid all wrong options.</p></div><SelectMenu id={`question-${questionIndex}-option-count`} label="Number of options" value={String(draft.options.length)} onChange={(value) => { const count = Number(value); updateDraft(questionIndex, { options: Array.from({ length: count }, (_, i) => draft.options[i] ?? ''), correct: draft.correct.filter((i) => i < count) }); }} options={Array.from({ length: 5 }, (_, i) => ({ value: String(i + 3), label: String(i + 3) }))}/></div><div className="grid gap-2 md:grid-cols-2">{draft.options.map((option, optionIndex) => <label key={optionIndex} className="flex min-w-0 items-center gap-2 rounded-lg bg-white p-2"><input aria-label={`Mark question ${questionIndex + 1} option ${optionIndex + 1} correct`} type="checkbox" checked={draft.correct.includes(optionIndex)} onChange={(event) => updateDraft(questionIndex, { correct: event.target.checked ? [...draft.correct, optionIndex] : draft.correct.filter((index) => index !== optionIndex) })} className="h-4 w-4 shrink-0 accent-emerald-500"/><span className="w-5 shrink-0 text-[11px] font-bold text-slate-400">{String.fromCharCode(65 + optionIndex)}</span><input className={`${input} min-w-0 font-normal`} required placeholder={`Option ${optionIndex + 1}`} value={option} onChange={(event) => updateDraft(questionIndex, { options: draft.options.map((item, itemIndex) => itemIndex === optionIndex ? event.target.value : item) })}/></label>)}</div></div> : <label className="block text-[11px] font-semibold text-slate-500">Expected answer <span className="font-normal text-slate-400">(private to grading)</span><input className={`${input} mt-1.5 font-normal`} required placeholder="Expected answer" value={draft.expected} onChange={(event) => updateDraft(questionIndex, { expected: event.target.value })}/></label>}
                <label className="block max-w-40 text-[11px] font-semibold text-slate-500">Marks<input className={`${input} mt-1.5`} type="number" min="1" required value={draft.marks} onChange={(event) => updateDraft(questionIndex, { marks: event.target.value })}/></label>
            </section>)}
            <div className="flex justify-end"><button className={button} disabled={busy || !bankId}><AddCircleIcon size={16}/>{busy ? 'Saving batch…' : `Save ${drafts.length} question${drafts.length === 1 ? '' : 's'}`}</button></div>
        </form>
    </AdminShell>;
}
