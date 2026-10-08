import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { Layout } from './components/Layout.tsx';
import { ApiError, meQuery } from './lib/api.ts';
import { AccountPage } from './pages/Account.tsx';
import { BudgetsPage } from './pages/Budgets.tsx';
import { ComparisonsPage } from './pages/Comparisons.tsx';
import { InvitePage } from './pages/Invite.tsx';
import { KeysPage } from './pages/Keys.tsx';
import { LoginPage } from './pages/Login.tsx';
import { LogsPage } from './pages/Logs.tsx';
import { ModelsPage } from './pages/Models.tsx';
import { OverviewPage } from './pages/Overview.tsx';
import { SettingsPage } from './pages/Settings.tsx';
import { SetupPage } from './pages/Setup.tsx';

const root = createRootRouteWithContext<{ queryClient: QueryClient }>()({ component: Outlet });

const login = createRoute({
  getParentRoute: () => root,
  path: '/login',
  validateSearch: (search: Record<string, unknown>) => ({
    error: typeof search.error === 'string' ? search.error : undefined,
  }),
  component: LoginPage,
});

const setup = createRoute({
  getParentRoute: () => root,
  path: '/setup',
  // The link the server prints to its logs carries the setup code.
  validateSearch: (search: Record<string, unknown>) => ({
    code: typeof search.code === 'string' ? search.code : undefined,
  }),
  component: SetupPage,
});

const invite = createRoute({
  getParentRoute: () => root,
  path: '/invite/$token',
  component: InvitePage,
});

const app = createRoute({
  getParentRoute: () => root,
  id: 'app',
  beforeLoad: async ({ context }) => {
    try {
      await context.queryClient.ensureQueryData(meQuery);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401)
        throw redirect({ to: '/login', search: { error: undefined } });
      throw error;
    }
  },
  component: Layout,
});

const adminOnly = async ({ context }: { context: { queryClient: QueryClient } }) => {
  const me = await context.queryClient.ensureQueryData(meQuery);
  if (me.user.role !== 'admin') throw redirect({ to: '/' });
};

const routeTree = root.addChildren([
  login,
  setup,
  invite,
  app.addChildren([
    createRoute({ getParentRoute: () => app, path: '/', component: OverviewPage }),
    createRoute({ getParentRoute: () => app, path: '/keys', component: KeysPage }),
    createRoute({ getParentRoute: () => app, path: '/budgets', component: BudgetsPage }),
    createRoute({
      getParentRoute: () => app,
      path: '/logs',
      validateSearch: (search: Record<string, unknown>) => ({
        id: typeof search.id === 'string' ? search.id : undefined,
      }),
      component: LogsPage,
    }),
    createRoute({
      getParentRoute: () => app,
      path: '/models',
      beforeLoad: adminOnly,
      component: ModelsPage,
    }),
    createRoute({
      getParentRoute: () => app,
      path: '/comparisons',
      beforeLoad: adminOnly,
      validateSearch: (search: Record<string, unknown>) => ({
        id: typeof search.id === 'string' ? search.id : undefined,
      }),
      component: ComparisonsPage,
    }),
    createRoute({
      getParentRoute: () => app,
      path: '/settings',
      beforeLoad: adminOnly,
      component: SettingsPage,
    }),
    createRoute({ getParentRoute: () => app, path: '/account', component: AccountPage }),
  ]),
]);

export function makeRouter(queryClient: QueryClient) {
  return createRouter({ routeTree, context: { queryClient }, defaultPreload: 'intent' });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof makeRouter>;
  }
}
