import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useI18n } from '../i18n/index.tsx';
import { api, unwrap } from '../lib/api.ts';
import { fmtNumber } from '../lib/format.ts';
import { Button, cx, ErrorNote } from './ui.tsx';

type Tone = 'ok' | 'warn' | 'block' | 'info';

const DOT: Record<Tone, string> = {
  ok: 'bg-ok-fg',
  warn: 'bg-warn-fg',
  block: 'bg-block-fg',
  info: 'bg-muted',
};

function Line({ tone, children }: { tone: Tone; children: string }) {
  return (
    <li className="flex gap-2.5">
      <span className={cx('mt-[5px] size-2 shrink-0 rounded-full', DOT[tone])} aria-hidden />
      <span>{children}</span>
    </li>
  );
}

/**
 * Whether the local model can stand in for a cloud model when Claude Code or Codex is rerouted
 * to it: context, tool calls and speed, with a one-click longer context for Ollama models.
 */
export function LocalModelCheck({ modelId }: { modelId: string }) {
  const { m } = useI18n();
  const queryClient = useQueryClient();
  const check = useMutation({
    mutationFn: () => unwrap(api.models[':id'].check.$post({ param: { id: modelId } })),
  });
  const lengthen = useMutation({
    mutationFn: () => unwrap(api.models[':id']['longer-context'].$post({ param: { id: modelId } })),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['models'] });
      check.mutate();
    },
  });
  const result = check.data;
  const busy = check.isPending || lengthen.isPending;
  const context = result?.context;
  const seconds = (tps: number) => fmtNumber(Math.max(1, 500 / tps));

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold">{m.localCheck.title}</div>
          <div className="text-[12px] text-muted">{m.localCheck.hint}</div>
        </div>
        <Button disabled={busy} onClick={() => check.mutate()}>
          {check.isPending ? m.localCheck.checking : result ? m.localCheck.again : m.localCheck.run}
        </Button>
      </div>
      <ErrorNote error={check.error ?? lengthen.error} />
      {result && context && (
        <ul className="flex flex-col gap-2 text-[13px] leading-snug">
          {context.inUse === null ? (
            <Line tone="info">{m.localCheck.contextUnknown(fmtNumber(context.needed))}</Line>
          ) : context.inUse >= context.needed ? (
            <Line tone="ok">{m.localCheck.contextOk(fmtNumber(context.inUse))}</Line>
          ) : (
            <Line tone="block">
              {m.localCheck.contextShort(fmtNumber(context.inUse), fmtNumber(context.needed)) +
                (context.max !== null && context.max < context.needed
                  ? ` ${m.localCheck.modelMax(fmtNumber(context.max))}`
                  : '')}
            </Line>
          )}
          {result.tools === null ? (
            <Line tone="info">{m.localCheck.toolsUnknown}</Line>
          ) : (
            <Line tone={result.tools ? 'ok' : 'block'}>
              {result.tools ? m.localCheck.toolsOk : m.localCheck.toolsNo}
            </Line>
          )}
          {result.tokensPerSecond !== null && (
            <Line tone={result.tokensPerSecond >= 15 ? 'ok' : 'warn'}>
              {m.localCheck.speed(
                fmtNumber(result.tokensPerSecond),
                seconds(result.tokensPerSecond),
              )}
            </Line>
          )}
        </ul>
      )}
      {result?.fix && (
        <div className="flex flex-col items-start gap-1.5">
          <Button variant="primary" disabled={busy} onClick={() => lengthen.mutate()}>
            {lengthen.isPending
              ? m.localCheck.fixing
              : m.localCheck.fix(fmtNumber(result.fix.context))}
          </Button>
          <p className="text-[12px] text-muted">{m.localCheck.fixHint(result.fix.name)}</p>
        </div>
      )}
    </div>
  );
}
