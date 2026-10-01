import { type ComponentProps, type ReactNode, useId, useState } from 'react';
import { useI18n } from '../i18n/index.tsx';
import { CheckIcon, CopyIcon } from './icons.tsx';

const cx = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(' ');

export { cx };

export function Button({
  variant = 'secondary',
  className,
  ...props
}: ComponentProps<'button'> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' }) {
  return (
    <button
      type="button"
      className={cx(
        'inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'primary' && 'bg-accent text-white hover:bg-accent-strong',
        variant === 'secondary' && 'border border-field bg-surface text-ink hover:bg-canvas',
        variant === 'ghost' && 'text-muted hover:bg-track hover:text-ink',
        variant === 'danger' && 'border border-field bg-surface text-block-fg hover:bg-block-bg',
        className,
      )}
      {...props}
    />
  );
}

export function Card({ className, ...props }: ComponentProps<'section'>) {
  return (
    <section className={cx('rounded-xl border border-line bg-surface', className)} {...props} />
  );
}

export function PageHeader({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-[26px] font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-3">{children}</div>}
    </header>
  );
}

export type Tone = 'ok' | 'warn' | 'info' | 'block' | 'off';

const TONES: Record<Tone, string> = {
  ok: 'bg-ok-bg text-ok-fg',
  warn: 'bg-warn-bg text-warn-fg',
  info: 'bg-info-bg text-info-fg',
  block: 'bg-block-bg text-block-fg',
  off: 'bg-off-bg text-off-fg',
};

export function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      className={cx(
        'inline-block rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap',
        TONES[tone],
      )}
    >
      {children}
    </span>
  );
}

export function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full bg-chip px-2 py-0.5 text-xs whitespace-nowrap text-ink-2">
      {children}
    </span>
  );
}

export function Progress({
  value,
  color = 'bg-accent',
  height = 6,
  label,
}: {
  value: number;
  color?: string;
  height?: number;
  label?: string;
}) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div
      className="w-full rounded-full bg-track"
      style={{ height }}
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div className={cx('rounded-full', color)} style={{ width: `${clamped}%`, height }} />
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <fieldset className="flex rounded-lg border-0 bg-track p-[3px]">
      <legend className="sr-only">{label}</legend>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={cx(
            'h-[34px] cursor-pointer rounded-md px-3.5 text-[13px] whitespace-nowrap',
            option.value === value
              ? 'bg-surface font-medium text-ink shadow-sm'
              : 'text-ink-2 hover:text-ink',
          )}
        >
          {option.label}
        </button>
      ))}
    </fieldset>
  );
}

const fieldClass =
  'h-10 w-full rounded-lg border border-field bg-surface px-3 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none';

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed as children
    <label className={cx('flex flex-col gap-1.5 text-[13px] font-medium', className)}>
      {label}
      {children}
      {hint && <span className="text-xs font-normal text-muted">{hint}</span>}
    </label>
  );
}

export function Input({ className, mono, ...props }: ComponentProps<'input'> & { mono?: boolean }) {
  return <input className={cx(fieldClass, mono && 'font-mono', className)} {...props} />;
}

export function Select({ className, ...props }: ComponentProps<'select'>) {
  return <select className={cx(fieldClass, 'px-2.5', className)} {...props} />;
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <label
      htmlFor={id}
      className="flex cursor-pointer items-start gap-2.5 text-[13px] leading-snug"
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-4 shrink-0 accent-accent"
      />
      <span>
        <span className="font-medium">{label}</span>
        {description && <span className="block text-muted">{description}</span>}
      </span>
    </label>
  );
}

export function Aside({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <aside
      aria-label={label}
      className={cx(
        'flex w-full shrink-0 flex-col gap-4 self-start rounded-xl border border-line bg-surface p-6 xl:sticky xl:top-8 xl:w-[380px]',
        className,
      )}
    >
      {children}
    </aside>
  );
}

/** Known server messages are shown in the viewer's language; anything else as it came. */
export function ErrorNote({ error }: { error: unknown }) {
  const { m } = useI18n();
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return (
    <p role="alert" className="rounded-lg bg-block-bg px-3 py-2 text-[13px] text-block-fg">
      {m.errors[message] ?? message}
    </p>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-5 py-10 text-center text-sm text-muted">{children}</div>;
}

export function CopyButton({ value, label }: { value: string; label?: string }) {
  const { m } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      {copied ? m.common.copied : (label ?? m.common.copy)}
    </Button>
  );
}

/** Masked spans like "[email hidden]" get a quiet highlight, in the viewer's language. */
export function MaskedText({ text }: { text: string }) {
  const { m } = useI18n();
  const label = (part: string) => {
    const kind = part.slice(1, -' hidden]'.length);
    return m.masked.label(m.masked.kinds[kind] ?? kind);
  };
  const parts = text.split(/(\[[a-z]+ hidden\])/g);
  return (
    <>
      {parts.map((part, i) =>
        /^\[[a-z]+ hidden\]$/.test(part) ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: static split of one string
          <span key={i} className="rounded bg-line px-1">
            {label(part)}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

export const KINDS = ['person', 'device', 'agent'] as const;
export type KeyKind = (typeof KINDS)[number];

export const RESULT_TONES: Record<string, Tone> = {
  ok: 'ok',
  rerouted: 'info',
  blocked_pii: 'block',
  blocked_budget: 'block',
  blocked_model: 'block',
  rate_limited: 'warn',
  error: 'off',
};
