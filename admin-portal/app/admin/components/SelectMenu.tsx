'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AltArrowDownIcon, CheckCircleIcon } from '@/lib/solar-icons';

export type SelectOption = { value: string; label: string; description?: string };

type SelectMenuProps = {
    id: string;
    value: string;
    options: SelectOption[];
    onChange: (value: string) => void;
    placeholder?: string;
    label?: string;
    disabled?: boolean;
    className?: string;
    leadingIcon?: ReactNode;
};

export function SelectMenu({ id, value, options, onChange, placeholder = 'Choose an option', label, disabled = false, className = '', leadingIcon }: SelectMenuProps) {
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const [menuPosition, setMenuPosition] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
    const selected = options.find((option) => option.value === value);

    useEffect(() => {
        const closeOnOutside = (event: MouseEvent) => {
            const target = event.target as Node;
            if (rootRef.current && !rootRef.current.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
        };
        const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
        document.addEventListener('mousedown', closeOnOutside);
        document.addEventListener('keydown', closeOnEscape);
        return () => {
            document.removeEventListener('mousedown', closeOnOutside);
            document.removeEventListener('keydown', closeOnEscape);
        };
    }, []);

    useEffect(() => {
        if (!open) return;
        const positionMenu = () => {
            const rect = buttonRef.current?.getBoundingClientRect();
            if (!rect) return;
            const gap = 8;
            const below = Math.max(0, window.innerHeight - rect.bottom - gap);
            const above = Math.max(0, rect.top - gap);
            const desiredHeight = Math.min(288, Math.max(120, options.length * 44 + 12));
            const opensUp = below < desiredHeight && above > below;
            const available = opensUp ? above : below;
            const maxHeight = Math.min(288, Math.max(80, available));
            const width = Math.min(rect.width, window.innerWidth - gap * 2);
            const left = Math.min(Math.max(gap, rect.left), window.innerWidth - width - gap);
            const top = opensUp ? Math.max(gap, rect.top - maxHeight - gap) : rect.bottom + gap;
            setMenuPosition({ top, left, width, maxHeight });
        };
        positionMenu();
        window.addEventListener('resize', positionMenu);
        window.addEventListener('scroll', positionMenu, true);
        return () => {
            window.removeEventListener('resize', positionMenu);
            window.removeEventListener('scroll', positionMenu, true);
        };
    }, [open, options.length]);

    return <div ref={rootRef} className={`relative min-w-0 ${className}`}>
        {label && <label id={`${id}-label`} className="mb-1.5 block text-xs font-semibold tracking-wide text-slate-500">{label}</label>}
        <button
            id={id}
            ref={buttonRef}
            type="button"
            disabled={disabled}
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-labelledby={label ? `${id}-label ${id}` : undefined}
            onClick={() => setOpen((current) => !current)}
            className="flex min-h-11 w-full items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 text-left text-sm text-slate-700 shadow-sm outline-none transition hover:border-emerald-300 focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
        >
            {leadingIcon && <span className="shrink-0 text-slate-400">{leadingIcon}</span>}
            <span className={`min-w-0 flex-1 truncate ${selected ? 'text-slate-800' : 'text-slate-400'}`}>{selected?.label ?? placeholder}</span>
            <AltArrowDownIcon size={17} className={`shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
        {open && menuPosition && typeof document !== 'undefined' && createPortal(<div ref={menuRef} role="listbox" aria-labelledby={label ? `${id}-label` : undefined} style={{ position: 'fixed', top: menuPosition.top, left: menuPosition.left, width: menuPosition.width, maxHeight: menuPosition.maxHeight, zIndex: 9999 }} className="overflow-y-auto rounded-xl border border-slate-200 bg-white p-1.5 shadow-[0_18px_45px_-20px_rgba(15,23,42,0.3)]">
            {options.length === 0 ? <p className="px-3 py-4 text-center text-xs text-slate-400">No options available</p> : options.map((option) => {
                const active = option.value === value;
                return <button key={option.value} type="button" role="option" aria-selected={active} onClick={() => { onChange(option.value); setOpen(false); }} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition ${active ? 'bg-emerald-50 text-emerald-800' : 'text-slate-700 hover:bg-slate-50'}`}>
                    <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{option.label}</span>{option.description && <span className="mt-0.5 block truncate text-xs text-slate-400">{option.description}</span>}</span>
                    {active && <CheckCircleIcon size={17} className="shrink-0 text-emerald-600" />}
                </button>;
            })}
        </div>, document.body)}
    </div>;
}
