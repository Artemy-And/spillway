import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { auth, meQuery } from '../lib/api.ts';
import {
  ChipIcon,
  CogIcon,
  GridIcon,
  HouseIcon,
  KeyIcon,
  ListIcon,
  LogoutIcon,
  MenuIcon,
  SlidersIcon,
} from './icons.tsx';
import { cx } from './ui.tsx';

const NAV = [
  { to: '/', label: 'Overview', icon: GridIcon, admin: false },
  { to: '/keys', label: 'Keys', icon: KeyIcon, admin: false },
  { to: '/budgets', label: 'Budgets & rules', icon: SlidersIcon, admin: false },
  { to: '/logs', label: 'Request log', icon: ListIcon, admin: false },
  { to: '/models', label: 'Models & providers', icon: ChipIcon, admin: true },
  { to: '/settings', label: 'Settings & SSO', icon: CogIcon, admin: true },
] as const;

export function Logo() {
  return (
    <div className="flex items-center gap-2.5 px-2.5">
      <div className="flex size-[30px] items-center justify-center rounded-lg bg-accent text-white">
        <HouseIcon strokeWidth={2.2} />
      </div>
      <div className="text-[17px] font-semibold tracking-tight">Gatehouse</div>
    </div>
  );
}

export function Layout() {
  const { data: me } = useQuery(meQuery);
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isAdmin = me?.user.role === 'admin';

  const signOut = async () => {
    await auth.logout.$post();
    queryClient.clear();
    await navigate({ to: '/login' });
  };

  return (
    <div className="flex min-h-dvh">
      <button
        type="button"
        aria-label="Open menu"
        onClick={() => setOpen(true)}
        className="fixed top-4 left-4 z-30 flex size-11 items-center justify-center rounded-lg bg-rail text-rail-ink lg:hidden"
      >
        <MenuIcon size={20} />
      </button>
      {open && (
        <button
          type="button"
          aria-label="Close menu"
          className="fixed inset-0 z-30 bg-black/30 lg:hidden"
          onClick={() => setOpen(false)}
        />
      )}
      <nav
        aria-label="Main"
        className={cx(
          'fixed inset-y-0 left-0 z-40 flex w-[232px] shrink-0 flex-col gap-7 bg-rail px-3.5 py-6 text-rail-ink transition-transform lg:sticky lg:top-0 lg:h-dvh lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <Logo />
        <div className="flex flex-col gap-0.5">
          {NAV.filter((item) => isAdmin || !item.admin).map((item) => (
            <Link
              key={item.to}
              to={item.to}
              onClick={() => setOpen(false)}
              activeOptions={{ exact: item.to === '/' }}
              className="flex items-center gap-2.5 rounded-lg p-2.5 text-sm font-medium text-rail-text no-underline hover:text-white"
              activeProps={{ className: 'bg-rail-active !text-white', 'aria-current': 'page' }}
            >
              <item.icon />
              {item.label}
            </Link>
          ))}
        </div>
        <div className="mt-auto flex flex-col gap-3">
          <div className="flex flex-col gap-1.5 rounded-[10px] bg-rail-2 p-3.5 text-xs text-rail-muted">
            <div className="flex items-center gap-2 text-[13px] text-rail-ink">
              <span className="size-2 rounded-full bg-healthy" />
              Gateway healthy
            </div>
            <div className="font-mono">{me?.gateway.host}</div>
            <div>
              {me?.gateway.providers ?? 0} providers · {me?.gateway.localProviders ?? 0} local
            </div>
            <div>v{me?.gateway.version} · self-hosted</div>
          </div>
          <div className="flex items-center justify-between gap-2 px-2.5 text-xs text-rail-muted">
            <span className="truncate" title={me?.user.email}>
              {me?.user.name ?? me?.user.email}
            </span>
            <button
              type="button"
              onClick={signOut}
              aria-label="Sign out"
              className="flex size-8 cursor-pointer items-center justify-center rounded-md hover:bg-rail-active hover:text-white"
            >
              <LogoutIcon />
            </button>
          </div>
        </div>
      </nav>
      <main className="flex min-w-0 flex-1 flex-col gap-6 px-4 pt-20 pb-10 sm:px-10 lg:pt-8">
        <Outlet />
      </main>
    </div>
  );
}
