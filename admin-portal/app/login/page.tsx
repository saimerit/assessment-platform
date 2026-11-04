'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircleIcon, LockKeyholeIcon, UsersGroupRoundedIcon } from '@/lib/solar-icons';

export default function LoginPage() {
    const [email, setEmail] = useState('admin@acmecorp.com');
    const [password, setPassword] = useState('Password123!');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const router = useRouter();

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setLoading(true);

        try {
            const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password }),
            });

            const data = await res.json();
            if (!res.ok) {
                throw new Error(data.error || 'Authentication failed');
            }

            localStorage.setItem('token', data.token);
            localStorage.setItem('user', JSON.stringify(data.user));

            if (data.user.role === 'INVIGILATOR_PROCTOR') {
                router.push('/proctor');
            } else if (data.user.role === 'CANDIDATE') {
                router.push('/candidate');
            } else {
                router.push('/admin');
            }
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <main className="min-h-screen bg-[#f4fbfa] px-4 py-6 text-slate-800 sm:px-8 lg:px-12">
            <div className="mx-auto flex min-h-[calc(100vh-3rem)] max-w-6xl items-center overflow-hidden rounded-[2rem] border border-emerald-100 bg-white shadow-[0_30px_90px_-45px_rgba(15,118,110,.35)]">
                <section className="hidden min-h-[620px] flex-1 flex-col justify-between bg-gradient-to-br from-emerald-500 via-teal-500 to-sky-500 p-10 text-white lg:flex">
                    <div><div className="flex items-center gap-3"><span className="grid h-11 w-11 place-items-center rounded-2xl bg-white/20 text-xl font-black">A</span><span className="text-lg font-extrabold tracking-tight">AssessPro</span><span className="rounded-full bg-white/20 px-2.5 py-1 text-[10px] font-bold">Console</span></div><h2 className="mt-24 max-w-md text-4xl font-black leading-tight">Welcome back to your assessment workspace.</h2><p className="mt-4 max-w-sm text-sm leading-6 text-emerald-50">Manage exams, candidates, question banks, proctors, and results from one focused workspace.</p></div>
                    <div className="grid gap-3 text-xs text-emerald-50"><div className="flex items-center gap-3 rounded-2xl bg-white/10 p-3"><CheckCircleIcon size={19}/><span>Secure role-based access</span></div><div className="flex items-center gap-3 rounded-2xl bg-white/10 p-3"><UsersGroupRoundedIcon size={19}/><span>Candidate and proctor workflows</span></div></div>
                </section>
                <section className="w-full max-w-xl p-7 sm:p-12">
                    <div className="mb-8 lg:hidden"><div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-emerald-500 text-lg font-black text-white">A</span><span className="text-lg font-extrabold">AssessPro</span><span className="rounded-full bg-emerald-100 px-2 py-1 text-[10px] font-bold text-emerald-700">Console</span></div></div>
                    <div className="mb-7"><p className="text-xs font-bold uppercase tracking-[.18em] text-emerald-600">Secure sign in</p><h1 className="mt-2 text-3xl font-black tracking-tight text-slate-900">Welcome back</h1><p className="mt-2 text-sm text-slate-500">Sign in to continue to your assessment workspace.</p></div>

                {error && (
                    <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
                        {error}
                    </div>
                )}

                <form onSubmit={handleLogin} className="space-y-4">
                    <div>
                            <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-500">
                            Email Address
                        </label>
                        <input
                            type="email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-3 text-sm text-slate-800 outline-none transition focus:border-emerald-400 focus:bg-white focus:ring-4 focus:ring-emerald-50"
                            required
                        />
                    </div>

                    <div>
                            <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-500">
                            Password
                        </label>
                        <input
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-3 text-sm text-slate-800 outline-none transition focus:border-emerald-400 focus:bg-white focus:ring-4 focus:ring-emerald-50"
                            required
                        />
                    </div>

                    <button
                        type="submit"
                        disabled={loading}
                        className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 px-4 py-3 font-bold text-white shadow-lg shadow-emerald-200 transition hover:from-emerald-600 hover:to-teal-600 disabled:opacity-50"
                    >
                        <LockKeyholeIcon size={16}/>{loading ? 'Authenticating...' : 'Sign In'}
                    </button>
                </form>

                <div className="mt-7 border-t border-slate-100 pt-5 text-center text-xs text-slate-400">
                    Demo: <code>admin@acmecorp.com</code> or <code>proctor@acmecorp.com</code>
                </div>
                </section>
            </div>
        </main>
    );
}
