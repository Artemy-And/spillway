import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/index.tsx';
import { api, unwrap } from '../lib/api.ts';
import { KeyIcon, ListIcon, SlidersIcon, SpillwayIcon } from './icons.tsx';
import { Button, cx } from './ui.tsx';

const ICONS = [SpillwayIcon, SlidersIcon, KeyIcon, ListIcon];

/** The tour shown once after the first sign-in; it ends on the getting-started checklist. */
export function Welcome({ admin }: { admin: boolean }) {
  const { m } = useI18n();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const slides = admin ? m.welcome.slides : m.welcome.memberSlides;
  const [index, setIndex] = useState(0);
  const primary = useRef<HTMLButtonElement>(null);
  const last = index === slides.length - 1;
  const slide = slides[index]!;
  const Icon = ICONS[index % ICONS.length]!;

  const done = useMutation({
    mutationFn: () => unwrap(api.me.$patch({ json: { welcomed: true, checklistHidden: false } })),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['me'] }),
  });

  const close = (toChecklist: boolean) => {
    done.mutate();
    if (toChecklist) void navigate({ to: '/' });
  };

  // Keyboard users land on the main button again after every slide change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: index is the trigger, not an input
  useEffect(() => {
    primary.current?.focus();
  }, [index]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={m.welcome.label}
        className="flex w-full max-w-md flex-col gap-6 rounded-2xl bg-surface p-7 shadow-2xl"
      >
        <div className="flex items-center justify-between">
          <div className="flex size-11 items-center justify-center rounded-xl bg-accent-soft text-accent-strong">
            <Icon size={22} strokeWidth={2} />
          </div>
          <button
            type="button"
            onClick={() => close(false)}
            className="cursor-pointer text-[13px] text-muted hover:text-ink"
          >
            {m.welcome.skip}
          </button>
        </div>
        <div className="flex min-h-[148px] flex-col gap-2.5" aria-live="polite">
          <div className="font-mono text-xs text-muted">
            {m.welcome.step(index + 1, slides.length)}
          </div>
          <h2 className="text-xl font-semibold tracking-tight">{slide.title}</h2>
          <p className="text-sm leading-relaxed text-ink-2">{slide.text}</p>
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="flex gap-1.5" aria-hidden="true">
            {slides.map((s, i) => (
              <span
                key={s.title}
                className={cx(
                  'h-1.5 rounded-full transition-all',
                  i === index ? 'w-5 bg-accent' : 'w-1.5 bg-track',
                )}
              />
            ))}
          </div>
          <div className="flex gap-2">
            {index > 0 && <Button onClick={() => setIndex(index - 1)}>{m.welcome.back}</Button>}
            <Button
              ref={primary}
              variant="primary"
              onClick={() => (last ? close(true) : setIndex(index + 1))}
            >
              {last ? (admin ? m.welcome.start : m.welcome.finish) : m.welcome.next}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
