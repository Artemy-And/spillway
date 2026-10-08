import type { ComparisonInput, TaskSetInput } from '@server/comparison/types.ts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { evaluationError } from '../i18n/evaluations.ts';
import { useI18n } from '../i18n/index.tsx';
import { api, meQuery, type TaskSetRow, unwrap } from '../lib/api.ts';
import { fmtDate } from '../lib/format.ts';
import { Button, ErrorNote, Field, Select, Status } from './ui.tsx';

export function taskContent(input: TaskSetInput): TaskSetInput {
  return {
    name: input.name.trim(),
    system: input.system,
    maxOutputTokens: input.maxOutputTokens,
    cases: input.cases.map((task) => ({
      ...task,
      name: task.name.trim(),
      prompt: task.prompt.trim(),
    })),
  };
}
export function matchesTaskSet(input: TaskSetInput, row: TaskSetRow) {
  const { name: _inputName, ...value } = taskContent(input);
  const { name: _savedName, ...saved } = row.content;
  return JSON.stringify(value) === JSON.stringify(saved);
}
export const taskSetsQuery = {
  queryKey: ['task-sets'],
  queryFn: () => unwrap(api['task-sets'].$get()),
};

export function TaskSetLibrary({
  input,
  selected,
  onLoad,
  onSelect,
  disabled,
}: {
  input: ComparisonInput;
  selected: TaskSetRow | null;
  onLoad: (row: TaskSetRow) => void;
  onSelect: (row: TaskSetRow | null) => void;
  disabled: boolean;
}) {
  const { m } = useI18n();
  const t = m.evaluations;
  const client = useQueryClient();
  const sets = useQuery(taskSetsQuery);
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => unwrap(api.settings.$get()) });
  const { data: me } = useQuery(meQuery);
  const changed = !!selected && !matchesTaskSet(input, selected);
  const load = useMutation({
    mutationFn: (id: string) => unwrap(api['task-sets'][':id'].$get({ param: { id } })),
    onSuccess: onLoad,
  });
  const save = useMutation({
    mutationFn: (update: boolean) =>
      update && selected
        ? unwrap(
            api['task-sets'][':id'].$put({
              param: { id: selected.id },
              json: { ...taskContent(input), revision: selected.revision },
            }),
          )
        : unwrap(api['task-sets'].$post({ json: taskContent(input) })),
    onSuccess: async (row) => {
      onSelect(row);
      await client.invalidateQueries({ queryKey: ['task-sets'] });
    },
  });
  const remove = useMutation({
    mutationFn: () =>
      unwrap(
        api['task-sets'][':id'].$delete({
          param: { id: selected!.id },
          json: { revision: selected!.revision },
        }),
      ),
    onSuccess: async () => {
      onSelect(null);
      await client.invalidateQueries({ queryKey: ['task-sets'] });
    },
  });
  const blocked =
    disabled || load.isPending || save.isPending || remove.isPending || !!me?.gateway.demo;
  const editable = settings.data?.storePrompts === true;
  const metadata = sets.data?.find(
    (row) => row.id === selected?.id && row.revision === selected.revision,
  );
  const reference = metadata ? metadata.reference : selected?.reference;
  return (
    <div className="space-y-3 rounded-lg border border-line p-4">
      <h2 className="text-base font-semibold">{t.title}</h2>
      <p className="text-xs text-muted">{t.hint}</p>
      <Field label={t.load}>
        <Select
          value={selected?.id ?? ''}
          disabled={blocked || !editable}
          onChange={(event) => {
            if (event.target.value) load.mutate(event.target.value);
            else onSelect(null);
          }}
        >
          <option value="">—</option>
          {sets.data?.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name} · {t.revision} {row.revision}
            </option>
          ))}
        </Select>
      </Field>
      {selected && (
        <div className="space-y-1 text-xs text-muted">
          <Status tone={changed ? 'warn' : 'info'}>
            {t.revision} {selected.revision}
          </Status>
          <p>
            {t.expires}: {fmtDate(selected.expiresAt)}
          </p>
          <p>
            {reference
              ? `${t.reference}: ${reference.name} · ${fmtDate(reference.createdAt)}`
              : t.noReference}
          </p>
        </div>
      )}
      {changed && <p className="text-xs text-warn-fg">{t.changed}</p>}
      <p className="text-xs text-muted">{editable ? t.privacy : t.storageOff}</p>
      <ErrorNote
        error={evaluationError(
          load.error ?? save.error ?? remove.error ?? sets.error ?? settings.error,
          t,
        )}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={blocked || !editable || !input.name.trim()}
          onClick={() => save.mutate(false)}
        >
          {t.save}
        </Button>
        {selected && (
          <>
            <Button disabled={blocked || !editable} onClick={() => load.mutate(selected.id)}>
              {t.load}
            </Button>
            <Button disabled={blocked || !editable} onClick={() => save.mutate(true)}>
              {t.update}
            </Button>
            <Button disabled={blocked} onClick={() => onSelect(null)}>
              {t.detach}
            </Button>
            <Button
              variant="danger"
              disabled={blocked}
              onClick={() => {
                if (confirm(t.confirmDelete)) remove.mutate();
              }}
            >
              {t.remove}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
