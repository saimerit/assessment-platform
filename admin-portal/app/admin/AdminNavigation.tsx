'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { getUserRole } from '@/lib/api';
import { ChartSquareIcon, ClipboardListIcon, LayersIcon, LockKeyholeIcon, LogoutIcon, UserPlusRoundedIcon, UsersGroupRoundedIcon, UserRoundedIcon } from '@/lib/solar-icons';

const destinations = [
    { href: '/admin', label: 'Invite candidates', Icon: UserPlusRoundedIcon },
    { href: '/admin/events', label: 'Exam assignment', Icon: ClipboardListIcon },
    { href: '/admin/questions', label: 'Question banks & papers', Icon: LayersIcon },
    { href: '/admin/proctors', label: 'Proctors', Icon: UserRoundedIcon },
    { href: '/admin/proctoring-code', label: 'Proctoring code', Icon: LockKeyholeIcon },
    { href: '/admin/candidates', label: 'Candidate management', Icon: UsersGroupRoundedIcon },
    { href: '/admin/results', label: 'Results', Icon: ChartSquareIcon },
];

export function AdminNavigation() {
    const pathname = usePathname();
    const router = useRouter();
    const role = getUserRole();
    return <div className="space-y-3">
    {role && role !== 'ORG_ADMIN' && role !== 'SUPER_ADMIN' && <p role="status" className="rounded border border-amber-500/30 bg-amber-950/20 px-3 py-2 text-xs text-amber-200">Signed in as {role}. You can view permitted data, but creating or assigning assessments requires your organization admin account. A 403 permission response will keep you signed in.</p>}
    <div className="flex items-center justify-between gap-3">
    <nav aria-label="Admin sections" className="flex min-w-0 gap-2 overflow-x-auto border-b border-slate-800 pb-3">
        {destinations.map((destination) => {
            const active = pathname === destination.href || (destination.href !== '/admin' && pathname.startsWith(`${destination.href}/`));
            const Icon = destination.Icon;
            return <Link key={destination.href} href={destination.href} aria-current={active ? 'page' : undefined}
                className={`flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition ${active ? 'bg-blue-600 text-white' : 'border border-slate-800 bg-slate-900 text-slate-300 hover:bg-slate-800'}`}>
                <Icon size={16} />{destination.label}
            </Link>;
        })}
    </nav>
    <button type="button" onClick={() => { localStorage.removeItem('token'); localStorage.removeItem('user'); router.push('/login'); }} className="flex shrink-0 items-center gap-2 rounded border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-300 hover:bg-slate-800"><LogoutIcon size={15} />Sign out</button>
    </div>
    </div>;
}
