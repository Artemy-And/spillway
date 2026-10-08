import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useI18n } from '../i18n/index.tsx';
import { ApiError, api, auth, meQuery, unwrap } from '../lib/api.ts';
import {
  ChipIcon,
  CogIcon,
  GridIcon,
  KeyIcon,
  ListIcon,
  LogoutIcon,
  MenuIcon,
  SlidersIcon,
  SpillwayIcon,
} from './icons.tsx';
import { cx } from './ui.tsx';
import { Welcome } from './Welcome.tsx';

const NAV = [
  { to: '/', label: 'overview', icon: GridIcon, admin: false },
  { to: '/keys', label: 'keys', icon: KeyIcon, admin: false },
  { to: '/budgets', label: 'budgets', icon: SlidersIcon, admin: false },
  { to: '/logs', label: 'logs', icon: ListIcon, admin: false },
  { to: '/models', label: 'models', icon: ChipIcon, admin: true },
  { to: '/comparisons', label: 'comparisons', icon: SlidersIcon, admin: true },
  { to: '/settings', label: 'settings', icon: CogIcon, admin: true },
] as const;

export function Logo() {
  return (
    <div className="flex items-center gap-2.5 px-2.5">
      <div className="flex size-[30px] items-center justify-center rounded-lg bg-accent text-white">
        <SpillwayIcon strokeWidth={2.2} />
      </div>
      <div className="text-[17px] font-semibold tracking-tight">Spillway</div>
    </div>
  );
}

export function Layout() {
  const { m } = useI18n();
  const { data: me } = useQuery(meQuery);
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isAdmin = me?.user.role === 'admin';
  // Answering at all means the gateway is up; the answer says which providers are failing.
  const status = useQuery({
    queryKey: ['status'],
    queryFn: () => unwrap(api.status.$get()),
    refetchInterval: 15_000,
    refetchIntervalInBackground: true,
    retry: false,
  });
  const offline =
    status.isError && !(status.error instanceof ApiError && status.error.status < 500);
  const failing = status.data?.failing ?? [];
  const health = offline
    ? { dot: 'bg-block-bar', text: m.nav.offline, hint: undefined }
    : failing.length
      ? { dot: 'bg-warn-bar', text: m.nav.degraded(failing.join(', ')), hint: m.nav.degradedHint }
      : { dot: 'bg-healthy', text: m.nav.healthy, hint: undefined };

  const signOut = async () => {
    await auth.logout.$post();
    queryClient.clear();
    await navigate({ to: '/login', search: { error: undefined } });
  };

  return (
    <div className="flex min-h-dvh">
      <button
        type="button"
        aria-label={m.nav.openMenu}
        onClick={() => setOpen(true)}
        className="fixed top-4 left-4 z-30 flex size-11 items-center justify-center rounded-lg bg-rail text-rail-ink lg:hidden"
      >
        <MenuIcon size={20} />
      </button>
      {open && (
        <button
          type="button"
          aria-label={m.nav.closeMenu}
          className="fixed inset-0 z-30 bg-black/30 lg:hidden"
          onClick={() => setOpen(false)}
        />
      )}
      <nav
        aria-label={m.nav.main}
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
              {m.nav[item.label]}
            </Link>
          ))}
        </div>
        <div className="mt-auto flex flex-col gap-3">
          <div className="flex flex-col gap-1.5 rounded-[10px] bg-rail-2 p-3.5 text-xs text-rail-muted">
            <div
              role="status"
              title={health.hint}
              className="flex items-center gap-2 text-[13px] text-rail-ink"
            >
              <span className={cx('size-2 shrink-0 rounded-full', health.dot)} />
              <span className="min-w-0 break-words">{health.text}</span>
            </div>
            <div className="font-mono">{me?.gateway.host}</div>
            <div>
              {m.nav.providers(me?.gateway.providers ?? 0, me?.gateway.localProviders ?? 0)}
            </div>
            <div>
              {m.nav.selfHosted(me?.gateway.version ?? '')}
              {me?.gateway.source && (
                <>
                  {' · '}
                  <a
                    href={me.gateway.source}
                    target="_blank"
                    rel="noreferrer"
                    className="text-rail-muted underline-offset-2 hover:text-white"
                  >
                    {m.nav.source}
                  </a>
                </>
              )}
            </div>
          </div>
          <div className="flex items-center justify-between gap-2 px-2.5 text-xs text-rail-muted">
            <Link
              to="/account"
              onClick={() => setOpen(false)}
              title={`${m.nav.account} · ${me?.user.email ?? ''}`}
              className="truncate text-rail-muted no-underline hover:text-white"
              activeProps={{ className: '!text-white', 'aria-current': 'page' }}
            >
              {me?.user.name ?? me?.user.email}
            </Link>
            <button
              type="button"
              onClick={signOut}
              aria-label={m.nav.signOut}
              title={m.nav.signOut}
              className="flex size-8 cursor-pointer items-center justify-center rounded-md hover:bg-rail-active hover:text-white"
            >
              <LogoutIcon />
            </button>
          </div>
        </div>
      </nav>
      <main className="flex min-w-0 flex-1 flex-col gap-6 px-4 pt-20 pb-10 sm:px-10 lg:pt-8">
        {offline && (
          <p role="alert" className="rounded-lg bg-block-bg px-4 py-2.5 text-[13px] text-block-fg">
            {m.nav.offlineBanner}
          </p>
        )}
        {me?.gateway.demo && (
          <p role="status" className="rounded-lg bg-info-bg px-4 py-2.5 text-[13px] text-info-fg">
            {m.nav.demoBanner}{' '}
            <a
              href={`${me.gateway.source}#quick-start`}
              className="font-medium whitespace-nowrap text-info-fg underline underline-offset-2"
            >
              {m.nav.demoInstall}
            </a>
          </p>
        )}
        <Outlet />
      </main>
      {me && !me.user.welcomed && <Welcome admin={isAdmin} />}
    </div>
  );
}
