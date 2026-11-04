'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { getUserRole } from '@/lib/api';
import {
    BellIcon, ChartSquareIcon, ClipboardListIcon, FileUserIcon,
    HomeIcon, LayersIcon, LogoutIcon, MagnifierIcon, QuestionCircleIcon, SettingsIcon,
    LockKeyholeIcon, UserPlusRoundedIcon, UsersGroupRoundedIcon, UserRoundedIcon,
} from '@/lib/solar-icons';

const navigation = [
    { href: '/admin', label: 'Dashboard', Icon: HomeIcon },
    { href: '/admin/events', label: 'Manage Exams & Invites', Icon: ClipboardListIcon },
    { href: '/admin/candidate-invitations', label: 'Organization Invites', Icon: UserPlusRoundedIcon },
    { href: '/admin/questions', label: 'Question Bank', Icon: LayersIcon },
    { href: '/admin/proctors', label: 'Proctors', Icon: UserRoundedIcon },
    { href: '/admin/proctoring-code', label: 'Proctoring Code', Icon: LockKeyholeIcon },
    { href: '/admin/candidates', label: 'Candidate Management', Icon: UsersGroupRoundedIcon },
    { href: '/admin/results', label: 'Results', Icon: ChartSquareIcon },
];

type AdminShellProps = { title: string; subtitle: string; children: ReactNode; action?: ReactNode };

export function AdminShell({ title, subtitle, children, action }: AdminShellProps) {
    const pathname = usePathname();
    const router = useRouter();
    const [role, setRole] = useState<string | null>(null);
    useEffect(() => setRole(getUserRole()), []);

    const signOut = () => {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        router.push('/login');
    };

    return <div className="min-h-screen bg-[#f6faf9] text-slate-800 md:grid md:grid-cols-[190px_minmax(0,1fr)]">
        <aside className="z-20 flex min-h-0 flex-col border-b border-emerald-100 bg-gradient-to-b from-[#f0fdfa] via-[#f7fffd] to-[#e7fbf4] px-3 py-4 md:sticky md:top-0 md:h-screen md:border-b-0 md:border-r md:border-r-emerald-100 md:px-3.5">
            <Link href="/admin" className="mb-7 flex items-center gap-2 px-1.5" aria-label="AssessPro dashboard">
                <span className="grid h-8 w-8 place-items-center rounded-xl bg-emerald-500 text-white shadow-sm shadow-emerald-200"><LayersIcon size={19} /></span>
                <span className="text-[15px] font-extrabold tracking-tight text-slate-800">AssessPro</span>
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[9px] font-bold text-emerald-700">Console</span>
            </Link>
            <nav aria-label="Admin dashboard" className="flex gap-1 overflow-x-auto md:flex-1 md:flex-col md:overflow-y-auto">
                {navigation.map(({ href, label, Icon }) => {
                    const targetPath = href.split('#')[0];
                    const active = pathname === targetPath && (targetPath !== '/admin' || href === '/admin');
                    return <Link key={href} href={href} aria-current={active ? 'page' : undefined} className={`group flex shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-[11px] font-medium transition ${active ? 'bg-emerald-100 text-emerald-800 shadow-sm shadow-emerald-100/80' : 'text-slate-600 hover:bg-white/80 hover:text-emerald-800'}`}>
                        <Icon size={17} className={active ? 'text-emerald-700' : 'text-slate-500 group-hover:text-emerald-700'} />
                        <span>{label}</span>
                    </Link>;
                })}
            </nav>
            <div className="mt-2 hidden border-t border-emerald-100 pt-3 md:block">
                <Link href="/admin/questions" className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[11px] font-medium text-slate-600 hover:bg-white/80 hover:text-emerald-800"><SettingsIcon size={17} className="text-slate-500" />Settings</Link>
                <Link href="/admin/questions" className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[11px] font-medium text-slate-600 hover:bg-white/80 hover:text-emerald-800"><QuestionCircleIcon size={17} className="text-slate-500" />Help &amp; Support</Link>
                <button type="button" onClick={signOut} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[11px] font-medium text-slate-600 hover:bg-white/80 hover:text-rose-600"><LogoutIcon size={17} className="text-slate-500" />Sign Out</button>
            </div>
        </aside>

        <div className="min-w-0">
            <header className="sticky top-0 z-10 flex h-[58px] items-center justify-between gap-4 border-b border-slate-100 bg-white/90 px-4 backdrop-blur-xl md:px-6">
                <label className="flex h-9 w-full max-w-[430px] items-center gap-2 rounded-lg border border-slate-200 bg-slate-50/70 px-3 text-slate-400 focus-within:border-emerald-300 focus-within:bg-white">
                    <MagnifierIcon size={16} />
                    <input aria-label="Search dashboard" className="w-full bg-transparent text-xs text-slate-700 outline-none placeholder:text-slate-400" placeholder="Search candidates, exams, or anything…" />
                </label>
                <div className="flex shrink-0 items-center gap-3">
                    <button type="button" aria-label="Notifications" className="relative grid h-8 w-8 place-items-center rounded-full border border-slate-100 bg-white text-slate-500 shadow-sm hover:text-emerald-700"><BellIcon size={17} /><span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-rose-400 ring-2 ring-white" /></button>
                    <span className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-emerald-400 to-teal-600 text-[11px] font-bold text-white">A</span>
                    <div className="hidden sm:block"><p className="text-[11px] font-semibold text-slate-700">Admin</p><p className="text-[9px] text-slate-400">{role ?? 'Organization console'}</p></div>
                    <button type="button" onClick={signOut} aria-label="Sign out" className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 hover:bg-slate-100 md:hidden"><LogoutIcon size={17} /></button>
                </div>
            </header>
            <main className="mx-auto w-full max-w-[1440px] space-y-5 px-4 py-5 md:px-6 md:py-6 xl:px-8">
                {role && role !== 'ORG_ADMIN' && role !== 'SUPER_ADMIN' && <p role="status" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-800">Signed in as {role}. Creating and assigning assessments requires your organization admin account.</p>}
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                        <span className="grid h-10 w-10 place-items-center rounded-2xl bg-violet-50 text-violet-600"><FileUserIcon size={21} /></span>
                        <div><h1 className="text-xl font-bold tracking-tight text-slate-900 md:text-[22px]">{title}</h1><p className="mt-0.5 text-xs text-slate-500">{subtitle}</p></div>
                    </div>
                    {action}
                </div>
                {children}
            </main>
        </div>
    </div>;
}
