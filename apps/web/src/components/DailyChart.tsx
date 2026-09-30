import { useState } from 'react';
import { fmtDate, fmtNumber } from '../lib/format.ts';

type Day = { date: string; cloud: number; local: number };

const PLOT_HEIGHT = 200;
const BAR_MAX = 24;

function niceMax(value: number): number {
  if (value <= 4) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((s) => s * magnitude * 4 >= value) ?? 10;
  return step * magnitude * 4;
}

const tick = (value: number) =>
  value >= 1000 ? `${Number((value / 1000).toFixed(1))}k` : String(value);

/**
 * Requests per day, cloud (paid) at the base and local (free) stacked on top,
 * with a 2px surface gap between segments and a tooltip per day.
 */
export function DailyChart({ days }: { days: Day[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(...days.map((d) => d.cloud + d.local), 0));
  const ticks = [4, 3, 2, 1, 0].map((i) => (max / 4) * i);
  const scale = (value: number) => (value / max) * PLOT_HEIGHT;

  return (
    <div className="flex flex-1 flex-col gap-2">
      <div className="flex gap-3">
        <div
          className="flex w-8 shrink-0 flex-col justify-between text-right font-mono text-[11px] text-faint"
          style={{ height: PLOT_HEIGHT }}
          aria-hidden="true"
        >
          {ticks.map((value) => (
            <span key={value} className="-my-1.5">
              {tick(value)}
            </span>
          ))}
        </div>
        <div className="relative flex flex-1 gap-1 sm:gap-3" style={{ height: PLOT_HEIGHT }}>
          <div
            className="pointer-events-none absolute inset-0 flex flex-col justify-between"
            aria-hidden="true"
          >
            {ticks.map((value) => (
              <div key={value} className="h-px bg-line-soft" />
            ))}
          </div>
          {days.map((day, i) => {
            const cloud = scale(day.cloud);
            const local = scale(day.local);
            const gap = cloud > 0 && local > 0 ? 2 : 0;
            return (
              // biome-ignore lint/a11y/noStaticElementInteractions: hover-only tooltip; the same numbers are in the table below
              <div
                key={day.date}
                className="relative flex flex-1 flex-col items-center justify-end"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              >
                <div
                  className="flex w-full flex-col items-center justify-end"
                  style={{ maxWidth: BAR_MAX, gap }}
                >
                  {local > 0 && (
                    <div
                      className="w-full bg-local"
                      style={{ height: Math.max(local - gap, 1), borderRadius: '4px 4px 0 0' }}
                    />
                  )}
                  {cloud > 0 && (
                    <div
                      className="w-full bg-accent"
                      style={{
                        height: Math.max(cloud, 1),
                        borderRadius: local > 0 ? 0 : '4px 4px 0 0',
                      }}
                    />
                  )}
                </div>
                {hover === i && (
                  <div className="pointer-events-none absolute bottom-full z-10 mb-2 w-max rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-lg">
                    <div className="mb-1 font-medium text-ink">
                      {fmtDate(day.date, { weekday: 'short', month: 'short', day: 'numeric' })}
                    </div>
                    <div className="flex items-center gap-2 text-ink-2">
                      <span className="size-2 rounded-sm bg-accent" />
                      Cloud{' '}
                      <span className="ml-auto pl-3 font-mono text-ink">
                        {fmtNumber(day.cloud)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-ink-2">
                      <span className="size-2 rounded-sm bg-local" />
                      Local{' '}
                      <span className="ml-auto pl-3 font-mono text-ink">
                        {fmtNumber(day.local)}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="ml-11 flex gap-1 border-t border-line pt-1.5 sm:gap-3" aria-hidden="true">
        {days.map((day, i) => (
          <div key={day.date} className="flex-1 text-center font-mono text-[11px] text-faint">
            {i % 2 === 0 || days.length <= 7 ? day.date.slice(8) : ''}
          </div>
        ))}
      </div>
      <table className="sr-only">
        <caption>Requests per day</caption>
        <thead>
          <tr>
            <th>Day</th>
            <th>Cloud</th>
            <th>Local</th>
          </tr>
        </thead>
        <tbody>
          {days.map((day) => (
            <tr key={day.date}>
              <td>{day.date}</td>
              <td>{day.cloud}</td>
              <td>{day.local}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
