import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useI18n } from '../i18n/index.tsx';
import { api, meQuery, unwrap } from '../lib/api.ts';
import { CheckIcon } from './icons.tsx';
import { Button, Card, cx, Progress } from './ui.tsx';

type Step = 'provider' | 'models' | 'local' | 'key' | 'request';

const LINKS = {
  provider: '/models',
  models: '/models',
  local: '/settings',
  key: '/keys',
  request: '/logs',
} as const;

/** Getting started, ticked off from the real state of the gateway rather than clicks. */
export function Checklist() {
  const { m } = useI18n();
  const queryClient = useQueryClient();
  const { data: me } = useQuery(meQuery);
  const isAdmin = me?.user.role === 'admin';
  const { data } = useQuery({
    queryKey: ['onboarding'],
    queryFn: () => unwrap(api.onboarding.$get()),
    refetchInterval: 10_000,
    enabled: !!me && !me.user.checklistHidden,
  });
  const hide = useMutation({
    mutationFn: () => unwrap(api.me.$patch({ json: { checklistHidden: true } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['me'] }),
  });

  if (!me || me.user.checklistHidden || !data) return null;

  const status: Record<Step, boolean> = {
    provider: data.providers > 0,
    models: data.models > 0,
    local: data.localModel,
    key: data.keys > 0,
    request: data.requests > 0,
  };
  const steps: Step[] = isAdmin
    ? ['provider', 'models', 'local', 'key', 'request']
    : ['key', 'request'];
  const done = steps.filter((step) => status[step]).length;
  const next = steps.find((step) => !status[step]);

  return (
    <Card aria-label={m.checklist.title} className="flex flex-col gap-4 px-6 py-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-[15px] font-semibold">{m.checklist.title}</h2>
          <span className="text-[13px] text-muted">
            {next ? m.checklist.progress(done, steps.length) : m.checklist.allDone}
          </span>
        </div>
        <Button variant="ghost" onClick={() => hide.mutate()} disabled={hide.isPending}>
          {m.checklist.hide}
        </Button>
      </div>
      <Progress value={(done / steps.length) * 100} label={m.checklist.title} />
      <ol className="flex flex-col">
        {steps.map((step, i) => {
          const text = m.checklist.steps[step];
          const complete = status[step];
          const current = step === next;
          return (
            <li
              key={step}
              className={cx(
                'flex items-start gap-3.5 border-b border-line-soft py-3 last:border-0',
                current && '-mx-3 rounded-lg border-transparent bg-accent-soft px-3',
              )}
            >
              <span
                className={cx(
                  'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full font-mono text-xs',
                  complete ? 'bg-accent text-white' : 'bg-track text-ink-2',
                )}
              >
                {complete ? <CheckIcon size={14} strokeWidth={2.6} /> : i + 1}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className={cx('text-sm font-medium', complete && 'text-muted line-through')}>
                  {text.title}
                </span>
                {!complete && <span className="text-[13px] text-muted">{text.text}</span>}
              </div>
              {!complete && (
                <Link
                  to={LINKS[step]}
                  search={step === 'request' ? { id: undefined } : undefined}
                  className={cx(
                    'inline-flex h-9 shrink-0 items-center rounded-lg px-3.5 text-[13px] font-medium no-underline',
                    current
                      ? 'bg-accent text-white hover:bg-accent-strong hover:text-white'
                      : 'border border-field bg-surface text-ink hover:bg-canvas hover:text-ink',
                  )}
                >
                  {text.action}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
