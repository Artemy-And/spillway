import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { PencilIcon, PlusIcon, TrashIcon } from '../components/icons.tsx';
import {
  Button,
  Card,
  Chip,
  cx,
  Empty,
  ErrorNote,
  Field,
  Input,
  PageHeader,
  Select,
  Switch,
} from '../components/ui.tsx';
import { useI18n } from '../i18n/index.tsx';
import { api, type ModelRow, modelsQuery, type ProviderRow, unwrap } from '../lib/api.ts';

type Kind = 'openai' | 'anthropic' | 'ollama';

const KIND_ORDER: Kind[] = ['openai', 'anthropic', 'ollama'];
/** Names the form suggests per type, replaced when the type changes unless edited. */
const DEFAULT_NAMES = ['Ollama', 'Anthropic', 'OpenAI', 'OpenAI-compatible'];

export function ModelsPage() {
  const { m } = useI18n();
  const queryClient = useQueryClient();
  const { data: providers = [] } = useQuery({
    queryKey: ['providers'],
    queryFn: () => unwrap(api.providers.$get()),
  });
  const { data: models = [] } = useQuery(modelsQuery);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [picking, setPicking] = useState<string | null>(null);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['providers'] }),
      queryClient.invalidateQueries({ queryKey: ['models'] }),
      queryClient.invalidateQueries({ queryKey: ['me'] }),
    ]);

  const removeProvider = useMutation({
    mutationFn: (id: string) => unwrap(api.providers[':id'].$delete({ param: { id } })),
    onSuccess: refresh,
  });

  return (
    <>
      <PageHeader title={m.models.title} subtitle={m.models.subtitle}>
        <Button variant="primary" onClick={() => setAdding(true)}>
          <PlusIcon strokeWidth={2.2} />
          {m.models.addProvider}
        </Button>
      </PageHeader>

      {adding && (
        <Card className="px-6 py-5">
          <ProviderForm
            onDone={async () => {
              await refresh();
              setAdding(false);
            }}
            onCancel={() => setAdding(false)}
          />
        </Card>
      )}

      <section
        aria-label={m.models.providers}
        className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3"
      >
        {providers.length === 0 && !adding && (
          <Card className="lg:col-span-2">
            <Empty>{m.models.noProviders}</Empty>
          </Card>
        )}
        {providers.map((provider) =>
          editing === provider.id ? (
            <Card key={provider.id} className="px-6 py-5">
              <ProviderForm
                provider={provider}
                onDone={async () => {
                  await refresh();
                  setEditing(null);
                }}
                onCancel={() => setEditing(null)}
              />
            </Card>
          ) : (
            <Card key={provider.id} className="flex flex-col gap-3 px-6 py-5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <h2 className="text-[15px] font-semibold">{provider.name}</h2>
                  <div className="flex flex-wrap gap-1.5">
                    <Chip>{m.models.kinds[provider.kind].label}</Chip>
                    {provider.isLocal && <Chip>{m.models.localFree}</Chip>}
                    {provider.kind !== 'ollama' && (
                      <Chip>{provider.hasApiKey ? m.models.keySet : m.models.noKey}</Chip>
                    )}
                  </div>
                </div>
                <div className="flex">
                  <button
                    type="button"
                    aria-label={m.common.edit(provider.name)}
                    onClick={() => setEditing(provider.id)}
                    className="flex size-9 cursor-pointer items-center justify-center rounded-md text-muted hover:bg-track hover:text-ink"
                  >
                    <PencilIcon />
                  </button>
                  <button
                    type="button"
                    aria-label={m.common.delete(provider.name)}
                    onClick={() =>
                      confirm(m.models.deleteConfirm(provider.name)) &&
                      removeProvider.mutate(provider.id)
                    }
                    className="flex size-9 cursor-pointer items-center justify-center rounded-md text-muted hover:bg-block-bg hover:text-block-fg"
                  >
                    <TrashIcon />
                  </button>
                </div>
              </div>
              <div className="truncate font-mono text-xs text-muted">{provider.baseUrl}</div>
              <div className="text-[13px] text-ink-2">
                {m.models.count(models.filter((row) => row.providerId === provider.id).length)}
              </div>
              {picking === provider.id ? (
                <ModelPicker
                  provider={provider}
                  existing={models}
                  onDone={async () => {
                    await refresh();
                    setPicking(null);
                  }}
                />
              ) : (
                <Button onClick={() => setPicking(provider.id)} className="self-start">
                  {m.models.addModels}
                </Button>
              )}
            </Card>
          ),
        )}
      </section>
      <ErrorNote error={removeProvider.error} />

      <Card aria-label={m.models.modelsTitle} className="overflow-x-auto px-6 py-4">
        <h2 className="mb-1 text-[15px] font-semibold">{m.models.modelsTitle}</h2>
        <p className="mb-3 text-[13px] text-muted">
          {m.models.introBefore} <code className="font-mono">model</code>
          {m.models.introAfter}
        </p>
        <div className="min-w-[860px]">
          <div className="grid grid-cols-[1.4fr_1.2fr_1fr_1.4fr_0.8fr_0.8fr_90px_40px] gap-3 border-b border-line py-2.5 text-xs font-medium text-muted">
            <div>{m.models.nameCol}</div>
            <div>{m.models.displayCol}</div>
            <div>{m.models.providerCol}</div>
            <div>{m.models.upstreamCol}</div>
            <div className="text-right">{m.models.inputCol}</div>
            <div className="text-right">{m.models.outputCol}</div>
            <div>{m.models.enabledCol}</div>
            <div />
          </div>
          {models.length === 0 && <Empty>{m.models.noModels}</Empty>}
          {models.map((model) => (
            <ModelLine key={model.id} model={model} onChange={refresh} />
          ))}
        </div>
      </Card>
    </>
  );
}

/** Adds a provider, or edits one when `provider` is given. */
function ProviderForm({
  provider,
  onDone,
  onCancel,
}: {
  provider?: ProviderRow;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { m } = useI18n();
  const { data: defaults } = useQuery({
    queryKey: ['provider-defaults'],
    queryFn: () => unwrap(api['provider-defaults'].$get()),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const [kind, setKind] = useState<Kind>(provider?.kind ?? 'ollama');
  const [name, setName] = useState(provider?.name ?? 'Ollama');
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [removeKey, setRemoveKey] = useState(false);
  const [isLocal, setIsLocal] = useState(provider?.isLocal ?? true);
  const save = useMutation({
    mutationFn: async () => {
      const json = {
        name: name.trim(),
        baseUrl: baseUrl.trim() || undefined,
        isLocal,
      };
      if (!provider) {
        await unwrap(
          api.providers.$post({ json: { ...json, kind, apiKey: apiKey.trim() || undefined } }),
        );
        return;
      }
      // An empty field keeps the saved key; an empty string tells the server to drop it.
      const key = removeKey ? { apiKey: '' } : apiKey.trim() ? { apiKey: apiKey.trim() } : {};
      await unwrap(
        api.providers[':id'].$patch({
          param: { id: provider.id },
          // An empty base URL resets it to the default for this kind.
          json: { ...json, baseUrl: baseUrl.trim() || null, ...key },
        }),
      );
    },
    onSuccess: onDone,
  });
  const wide = provider ? undefined : 'md:col-span-2';
  const keyHint = provider?.hasApiKey ? m.models.keySaved : m.models.keyEncrypted;
  return (
    <form
      className={cx('grid grid-cols-1 gap-4', !provider && 'md:grid-cols-2')}
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <h2 className={cx('text-[17px] font-semibold', wide)}>
        {provider ? m.common.edit(provider.name) : m.models.newProvider}
      </h2>
      <Field label={m.common.type} hint={m.models.kinds[kind].hint}>
        <Select
          disabled={!!provider}
          value={kind}
          onChange={(e) => {
            const next = e.target.value as Kind;
            setKind(next);
            setIsLocal(next === 'ollama');
            if (!name.trim() || DEFAULT_NAMES.includes(name)) {
              setName(next === 'openai' ? 'OpenAI' : m.models.kinds[next].label);
            }
          }}
        >
          {KIND_ORDER.map((k) => (
            <option key={k} value={k}>
              {m.models.kinds[k].label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={m.common.name}>
        <Input required value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label={m.models.baseUrl} hint={m.models.baseUrlHint}>
        <Input
          mono
          placeholder={defaults?.[kind]}
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      </Field>
      <Field label={m.models.apiKey} hint={keyHint}>
        <Input
          mono
          type="password"
          autoComplete="off"
          disabled={removeKey}
          placeholder={
            kind === 'ollama'
              ? m.models.notNeeded
              : provider?.hasApiKey
                ? m.models.savedPlaceholder
                : 'sk-…'
          }
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </Field>
      {provider?.hasApiKey && (
        <Switch checked={removeKey} onChange={setRemoveKey} label={m.models.removeKey} />
      )}
      <div className={wide}>
        <Switch
          checked={isLocal}
          onChange={setIsLocal}
          label={m.models.ownHardware}
          description={m.models.ownHardwareHint}
        />
      </div>
      <div className={wide}>
        <ErrorNote error={save.error} />
      </div>
      <div className={cx('flex justify-end gap-2.5', wide)}>
        <Button onClick={onCancel}>{m.common.cancel}</Button>
        <Button type="submit" variant="primary" disabled={save.isPending}>
          {provider ? m.common.save : m.models.addProvider}
        </Button>
      </div>
    </form>
  );
}

function ModelPicker({
  provider,
  existing,
  onDone,
}: {
  provider: ProviderRow;
  existing: ModelRow[];
  onDone: () => void;
}) {
  const { m } = useI18n();
  const [chosen, setChosen] = useState<string[]>([]);
  const [manual, setManual] = useState('');
  const available = useQuery({
    queryKey: ['available', provider.id],
    queryFn: () => unwrap(api.providers[':id'].available.$get({ param: { id: provider.id } })),
    retry: false,
  });
  const taken = new Set(
    existing.filter((m) => m.providerId === provider.id).map((m) => m.upstreamModel),
  );
  const add = useMutation({
    mutationFn: async () => {
      const names = [
        ...chosen,
        ...manual
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ];
      for (const upstream of names) {
        const name = upstream.replace(/[^\w.:/@-]/g, '-');
        await unwrap(
          api.models.$post({ json: { providerId: provider.id, name, upstreamModel: upstream } }),
        );
      }
    },
    onSuccess: onDone,
  });
  const [filter, setFilter] = useState('');
  const options = (available.data?.models ?? []).filter((m) => !taken.has(m));
  // Aggregators like OpenRouter list hundreds of models; chosen ones stay visible while filtering.
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = options.filter(
    (m) => chosen.includes(m) || words.every((w) => m.toLowerCase().includes(w)),
  );

  return (
    <div className="flex flex-col gap-3 rounded-lg bg-canvas p-3">
      {available.isLoading && (
        <p className="text-[13px] text-muted">{m.models.asking(provider.name)}</p>
      )}
      {available.error && <ErrorNote error={available.error} />}
      {options.length > 12 && (
        <Input
          aria-label={m.models.filterLabel}
          mono
          placeholder={m.models.filterPlaceholder(options.length)}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      )}
      {options.length > 0 && (
        <div className="flex max-h-56 flex-col gap-1.5 overflow-y-auto">
          {shown.length === 0 && <p className="text-[13px] text-muted">{m.models.noMatch}</p>}
          {shown.map((name) => (
            <label key={name} className="flex items-center gap-2.5 font-mono text-[13px]">
              <input
                type="checkbox"
                className="size-4 accent-accent"
                checked={chosen.includes(name)}
                onChange={(e) =>
                  setChosen(e.target.checked ? [...chosen, name] : chosen.filter((n) => n !== name))
                }
              />
              {name}
            </label>
          ))}
        </div>
      )}
      {available.isSuccess && options.length === 0 && (
        <p className="text-[13px] text-muted">{m.models.allAdded(provider.name)}</p>
      )}
      <Field label={m.models.manual}>
        <Input
          mono
          placeholder="claude-sonnet-4-5, gpt-5-mini"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
        />
      </Field>
      <ErrorNote error={add.error} />
      <div className="flex justify-end gap-2">
        <Button onClick={onDone}>{m.common.cancel}</Button>
        <Button
          variant="primary"
          disabled={add.isPending || (!chosen.length && !manual.trim())}
          onClick={() => add.mutate()}
        >
          {m.models.addN(chosen.length + manual.split(',').filter((s) => s.trim()).length)}
        </Button>
      </div>
    </div>
  );
}

function ModelLine({ model, onChange }: { model: ModelRow; onChange: () => void }) {
  const { m } = useI18n();
  const update = useMutation({
    mutationFn: (json: {
      name?: string;
      upstreamModel?: string;
      label?: string | null;
      inputPrice?: number;
      outputPrice?: number;
      enabled?: boolean;
    }) => unwrap(api.models[':id'].$patch({ param: { id: model.id }, json })),
    onSuccess: onChange,
  });
  const remove = useMutation({
    mutationFn: () => unwrap(api.models[':id'].$delete({ param: { id: model.id } })),
    onSuccess: onChange,
  });
  const price = (field: 'inputPrice' | 'outputPrice') => (
    <Input
      aria-label={(field === 'inputPrice' ? m.models.inputLabel : m.models.outputLabel)(model.name)}
      mono
      type="number"
      min="0"
      step="any"
      disabled={model.isLocal}
      defaultValue={model[field]}
      className="h-8 text-right"
      onBlur={(e) => {
        const value = Number(e.target.value || 0);
        if (value !== model[field]) update.mutate({ [field]: value });
      }}
    />
  );
  // Text fields save on blur; an empty value is not a valid name, so it snaps back.
  const text = (field: 'name' | 'upstreamModel', label: string, className?: string) => (
    <Input
      aria-label={label}
      mono
      required
      className={cx('h-8', className)}
      defaultValue={model[field]}
      title={model[field]}
      onBlur={(e) => {
        const value = e.target.value.trim();
        if (!value) e.target.value = model[field];
        else if (value !== model[field]) update.mutate({ [field]: value });
      }}
    />
  );
  return (
    <div className="grid grid-cols-[1.4fr_1.2fr_1fr_1.4fr_0.8fr_0.8fr_90px_40px] items-center gap-3 border-b border-line-soft py-2 text-sm last:border-0">
      {text('name', m.models.nameLabel(model.name), 'text-[13px] font-medium')}
      <Input
        aria-label={m.models.displayLabel(model.name)}
        className="h-8"
        placeholder={model.name}
        defaultValue={model.label ?? ''}
        onBlur={(e) => {
          const label = e.target.value.trim() || null;
          if (label !== model.label) update.mutate({ label });
        }}
      />
      <span className="truncate text-ink-2">
        {model.provider}
        {model.isLocal && <span className="text-muted"> · {m.common.local}</span>}
      </span>
      {text('upstreamModel', m.models.upstreamLabel(model.name), 'text-xs')}
      {price('inputPrice')}
      {price('outputPrice')}
      <input
        type="checkbox"
        aria-label={m.models.enabledLabel(model.name)}
        checked={model.enabled}
        onChange={(e) => update.mutate({ enabled: e.target.checked })}
        className="size-4 accent-accent"
      />
      <button
        type="button"
        aria-label={m.common.delete(model.name)}
        onClick={() => confirm(m.models.deleteModelConfirm(model.name)) && remove.mutate()}
        className="flex size-8 cursor-pointer items-center justify-center rounded-md text-muted hover:bg-block-bg hover:text-block-fg"
      >
        <TrashIcon />
      </button>
      {(update.error || remove.error) && (
        <div className="col-span-full">
          <ErrorNote error={update.error ?? remove.error} />
        </div>
      )}
    </div>
  );
}
