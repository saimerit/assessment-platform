'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AltArrowDownIcon, AltArrowLeftIcon, AltArrowRightIcon, CalendarDateIcon } from '@/lib/solar-icons';

type DateTimePickerProps = {
    id: string;
    label: string;
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
};

const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const pad = (value: number) => String(value).padStart(2, '0');

function valueToDate(value: string): Date | null {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toLocalValue(date: Date): string {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDateTime(date: Date | null, placeholder: string): string {
    if (!date) return placeholder;
    const dateLabel = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
    const timeLabel = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
    return `${dateLabel} · ${timeLabel}`;
}

export function DateTimePicker({ id, label, value, onChange, placeholder = 'Select date and time' }: DateTimePickerProps) {
    const [open, setOpen] = useState(false);
    const [month, setMonth] = useState(() => {
        // Use a deterministic SSR fallback; Next's cached prerender disallows reading the clock during render.
        const selected = valueToDate(value) ?? new Date(2000, 0, 1);
        return new Date(selected.getFullYear(), selected.getMonth(), 1);
    });
    const [today, setToday] = useState<Date | null>(null);
    const [timeMenu, setTimeMenu] = useState<'hour' | 'minute' | null>(null);
    const rootRef = useRef<HTMLDivElement>(null);
    const popoverRef = useRef<HTMLDivElement>(null);
    const [popoverPosition, setPopoverPosition] = useState({ left: 8, top: 8, maxHeight: 560, width: 350 });
    const selected = valueToDate(value);

    useEffect(() => {
        if (selected) setMonth(new Date(selected.getFullYear(), selected.getMonth(), 1));
    }, [value]);

    useEffect(() => {
        const now = new Date();
        setToday(now);
        if (!selected) setMonth(new Date(now.getFullYear(), now.getMonth(), 1));
    }, []);

    useEffect(() => {
        const closeOnOutside = (event: MouseEvent) => {
            const target = event.target as Node;
            if (!rootRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
                setOpen(false);
                setTimeMenu(null);
            }
        };
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') { setOpen(false); setTimeMenu(null); }
        };
        document.addEventListener('mousedown', closeOnOutside);
        document.addEventListener('keydown', closeOnEscape);
        return () => {
            document.removeEventListener('mousedown', closeOnOutside);
            document.removeEventListener('keydown', closeOnEscape);
        };
    }, []);

    useEffect(() => {
        if (!open) return;
        const updatePosition = () => {
            const anchor = rootRef.current?.querySelector('button');
            if (!anchor) return;
            const rect = anchor.getBoundingClientRect();
            const width = Math.min(350, window.innerWidth - 16);
            const maxHeight = Math.max(240, window.innerHeight - 16);
            const naturalHeight = Math.min(560, maxHeight);
            const spaceBelow = window.innerHeight - rect.bottom - 8;
            const spaceAbove = rect.top - 8;
            const top = spaceBelow < naturalHeight && spaceAbove > spaceBelow
                ? Math.max(8, rect.top - naturalHeight - 8)
                : Math.min(window.innerHeight - naturalHeight - 8, rect.bottom + 8);
            const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
            setPopoverPosition({ left, top, maxHeight, width });
        };
        updatePosition();
        window.addEventListener('resize', updatePosition);
        window.addEventListener('scroll', updatePosition, true);
        return () => {
            window.removeEventListener('resize', updatePosition);
            window.removeEventListener('scroll', updatePosition, true);
        };
    }, [open]);

    const year = month.getFullYear();
    const monthIndex = month.getMonth();
    const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
    const mondayOffset = (new Date(year, monthIndex, 1).getDay() + 6) % 7;
    const calendarCells = [...Array(mondayOffset).fill(null), ...Array.from({ length: daysInMonth }, (_, index) => index + 1)];
    while (calendarCells.length % 7) calendarCells.push(null);
    const hour = selected?.getHours() ?? 9;
    const minute = selected?.getMinutes() ?? 0;

    const setDatePart = (day: number, nextHour = hour, nextMinute = minute) => {
        const next = new Date(year, monthIndex, day, nextHour, nextMinute, 0, 0);
        onChange(toLocalValue(next));
    };
    const setTimePart = (nextHour: number, nextMinute: number) => {
        const base = selected ?? new Date(year, monthIndex, 1, 9, 0, 0, 0);
        onChange(toLocalValue(new Date(base.getFullYear(), base.getMonth(), base.getDate(), nextHour, nextMinute, 0, 0)));
    };

    return <div ref={rootRef} className="relative min-w-0">
        <label htmlFor={id} className="mb-1.5 block text-xs font-semibold tracking-wide text-slate-500">{label}</label>
        <button id={id} type="button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((current) => !current)} className="flex min-h-11 w-full items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 text-left text-sm shadow-sm outline-none transition hover:border-emerald-300 focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100">
            <CalendarDateIcon size={17} className="shrink-0 text-slate-400" />
            <span className={`min-w-0 flex-1 truncate ${selected ? 'text-slate-800' : 'text-slate-400'}`}>{formatDateTime(selected, placeholder)}</span>
            <AltArrowDownIcon size={16} className={`shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
        {open && typeof document !== 'undefined' && createPortal(<div ref={popoverRef} role="dialog" aria-label={`${label} calendar and time`} style={{ position: 'fixed', left: popoverPosition.left, top: popoverPosition.top, width: popoverPosition.width, maxHeight: popoverPosition.maxHeight }} className="z-[1000] overflow-y-auto overscroll-contain rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_24px_60px_-24px_rgba(15,23,42,0.35)]">
            <div className="mb-4 flex items-center justify-between">
                <div><p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">Choose a date</p><h3 className="mt-1 text-sm font-bold text-slate-800">{new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(month)}</h3></div>
                <div className="flex gap-1"><button type="button" aria-label="Previous month" onClick={() => setMonth(new Date(year, monthIndex - 1, 1))} className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 hover:bg-slate-100"><AltArrowLeftIcon size={17} /></button><button type="button" aria-label="Next month" onClick={() => setMonth(new Date(year, monthIndex + 1, 1))} className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 hover:bg-slate-100"><AltArrowRightIcon size={17} /></button></div>
            </div>
            <div role="grid" aria-label="Calendar" className="grid grid-cols-7 gap-1 text-center">
                {weekdays.map((day) => <div key={day} role="columnheader" className="py-1 text-[10px] font-semibold uppercase text-slate-400">{day}</div>)}
                {calendarCells.map((day, index) => {
                    if (!day) return <span key={`empty-${index}`} />;
                    const active = selected?.getFullYear() === year && selected?.getMonth() === monthIndex && selected?.getDate() === day;
                    const isToday = today?.getFullYear() === year && today.getMonth() === monthIndex && today.getDate() === day;
                    return <button key={day} type="button" role="gridcell" aria-selected={active} onClick={() => setDatePart(day)} className={`mx-auto grid h-9 w-9 place-items-center rounded-xl text-xs font-medium transition ${active ? 'bg-emerald-500 text-white shadow-sm shadow-emerald-200' : isToday ? 'bg-emerald-50 text-emerald-700' : 'text-slate-600 hover:bg-slate-100'}`}>{day}</button>;
                })}
            </div>
            <div className="mt-4 border-t border-slate-100 pt-3">
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">Time</p>
                <div className="flex items-center gap-2">
                    <div className="relative flex-1"><button type="button" aria-haspopup="listbox" aria-expanded={timeMenu === 'hour'} onClick={() => setTimeMenu(timeMenu === 'hour' ? null : 'hour')} className="flex h-10 w-full items-center justify-between rounded-lg border border-slate-200 px-3 text-sm font-semibold text-slate-700 hover:border-emerald-300">{pad(hour)} <AltArrowDownIcon size={15} className="text-slate-400" /></button>{timeMenu === 'hour' && <div role="listbox" aria-label="Hour" className="absolute bottom-[calc(100%+5px)] z-[100] max-h-48 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white p-1 shadow-xl">{Array.from({ length: 24 }, (_, item) => <button key={item} type="button" role="option" aria-selected={item === hour} onClick={() => { setTimePart(item, minute); setTimeMenu(null); }} className={`block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-emerald-50 ${item === hour ? 'bg-emerald-50 font-bold text-emerald-700' : 'text-slate-700'}`}>{pad(item)}</button>)}</div>}</div>
                    <span className="text-slate-400">:</span>
                    <div className="relative flex-1"><button type="button" aria-haspopup="listbox" aria-expanded={timeMenu === 'minute'} onClick={() => setTimeMenu(timeMenu === 'minute' ? null : 'minute')} className="flex h-10 w-full items-center justify-between rounded-lg border border-slate-200 px-3 text-sm font-semibold text-slate-700 hover:border-emerald-300">{pad(minute)} <AltArrowDownIcon size={15} className="text-slate-400" /></button>{timeMenu === 'minute' && <div role="listbox" aria-label="Minute" className="absolute bottom-[calc(100%+5px)] z-[100] max-h-48 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white p-1 shadow-xl">{Array.from({ length: 60 }, (_, item) => <button key={item} type="button" role="option" aria-selected={item === minute} onClick={() => { setTimePart(hour, item); setTimeMenu(null); }} className={`block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-emerald-50 ${item === minute ? 'bg-emerald-50 font-bold text-emerald-700' : 'text-slate-700'}`}>{pad(item)}</button>)}</div>}</div>
                    <span className="text-xs text-slate-400">24-hour</span>
                </div>
                <div className="mt-3 flex items-center justify-between"><span className="text-xs text-slate-500">{selected ? formatDateTime(selected, '') : 'Select a date, then set the time'}</span><button type="button" onClick={() => { if (selected) setOpen(false); }} disabled={!selected} className="rounded-lg bg-emerald-500 px-3 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-40">Done</button></div>
            </div>
        </div>, document.body)}
    </div>;
}
