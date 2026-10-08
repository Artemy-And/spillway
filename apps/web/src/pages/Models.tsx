import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { PencilIcon, PlusIcon, TrashIcon } from '../components/icons.tsx';
import { ModelAliases } from '../components/ModelAliases.tsx';
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
import { fmtDate, fmtUsd } from '../lib/format.ts';

type Kind = 'openai' | 'anthropic' | 'ollama';

const MODEL_GRID = 'grid grid-cols-[1.4fr_1.2fr_1fr_1.4fr_0.8fr_0.8fr_0.8fr_90px_40px] gap-3';

/** Placeholder in a base URL the admin has to replace, like Azure's resource name. */
const FILL_IN = 'YOUR-RESOURCE';

/**
 * Services the new-provider form fills in. Everything but Anthropic and Ollama is reached
 * through its OpenAI-compatible API; Azure's v1 API needs no api-version.
 */
const PRESETS = {
  ollama: { kind: 'ollama', name: 'Ollama', baseUrl: '' },
  openai: { kind: 'openai', name: 'OpenAI', baseUrl: '' },
  anthropic: { kind: 'anthropic', name: 'Anthropic', baseUrl: '' },
  azure: {
    kind: 'openai',
    name: 'Azure OpenAI',
    baseUrl: `https://${FILL_IN}.openai.azure.com/openai/v1`,
  },
  gemini: {
    kind: 'openai',
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  },
  mistral: { kind: 'openai', name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1' },
  groq: { kind: 'openai', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1' },
  deepseek: { kind: 'openai', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  xai: { kind: 'openai', name: 'xAI', baseUrl: 'https://api.x.ai/v1' },
  openrouter: { kind: 'openai', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  custom: { kind: 'openai', name: 'OpenAI-compatible', baseUrl: '' },
} satisfies Record<string, { kind: Kind; name: string; baseUrl: string }>;

type Preset = keyof typeof PRESETS;
const PRESET_ORDER = Object.keys(PRESETS) as Preset[];
/** Names the form suggests, replaced when the service changes unless edited. */
const DEFAULT_NAMES = Object.values(PRESETS).map((preset) => preset.name);

export function ModelsPage() {
  const { m } = useI18n();
  const queryClient = useQueryClient();
  const { data: providers = [] } = useQuery({
    queryKey: ['providers'],
    queryFn: () => unwrap(api.providers.$get()),
  });
  const { data: models = [] } = useQuery(modelsQuery);
  const { data: priceList } = useQuery({
    queryKey: ['price-list'],
    queryFn: () => unwrap(api['price-list'].$get()),
    staleTime: Number.POSITIVE_INFINITY,
  });
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
        <p className="mb-1 text-[13px] text-muted">
          {m.models.introBefore} <code className="font-mono">model</code>
          {m.models.introAfter}
        </p>
        {priceList && (
          <p className="mb-3 text-[13px] text-muted">
            {m.models.listNote(fmtDate(priceList.date, { month: 'long', year: 'numeric' }))}
          </p>
        )}
        <div className="min-w-[960px]">
          <div
            className={cx(MODEL_GRID, 'border-b border-line py-2.5 text-xs font-medium text-muted')}
          >
            <div>{m.models.nameCol}</div>
            <div>{m.models.displayCol}</div>
            <div>{m.models.providerCol}</div>
            <div>{m.models.upstreamCol}</div>
            <div className="text-right">{m.models.inputCol}</div>
            <div className="text-right">{m.models.outputCol}</div>
            <div className="text-right" title={m.models.cachedHint}>
              {m.models.cachedCol}
            </div>
            <div>{m.models.enabledCol}</div>
            <div />
          </div>
          {models.length === 0 && <Empty>{m.models.noModels}</Empty>}
          {models.map((model) => (
            <ModelLine key={model.id} model={model} onChange={refresh} />
          ))}
        </div>
      </Card>
      <ModelAliases />
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
  const [preset, setPreset] = useState<Preset>('ollama');
  const kind: Kind = provider?.kind ?? PRESETS[preset].kind;
  const [name, setName] = useState(provider?.name ?? 'Ollama');
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '');
  const unfinished = baseUrl.includes(FILL_IN);
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
      {provider ? (
        <Field label={m.common.type} hint={m.models.kinds[kind].hint}>
          <Select disabled value={kind}>
            <option value={kind}>{m.models.kinds[kind].label}</option>
          </Select>
        </Field>
      ) : (
        <Field
          label={m.models.service}
          hint={m.models.presetHints[preset] ?? m.models.kinds[kind].hint}
        >
          <Select
            value={preset}
            onChange={(e) => {
              const next = e.target.value as Preset;
              setPreset(next);
              setIsLocal(next === 'ollama');
              setBaseUrl(PRESETS[next].baseUrl);
              if (!name.trim() || DEFAULT_NAMES.includes(name)) setName(PRESETS[next].name);
            }}
          >
            {PRESET_ORDER.map((id) => (
              <option key={id} value={id}>
                {id === 'custom' ? m.models.otherService : PRESETS[id].name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field label={m.common.name}>
        <Input required value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field
        label={m.models.baseUrl}
        hint={unfinished ? m.models.fillIn(FILL_IN) : m.models.baseUrlHint}
      >
        <Input
          mono
          required={preset === 'custom' && !provider}
          placeholder={preset === 'custom' ? 'http://vllm:8000/v1' : defaults?.[kind]}
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
        <Button type="submit" variant="primary" disabled={save.isPending || unfinished}>
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
        // Prices the provider lists go along; for the rest the server checks its price list.
        const price = available.data?.prices[upstream];
        await unwrap(
          api.models.$post({
            json: {
              providerId: provider.id,
              name,
              upstreamModel: upstream,
              ...(price
                ? {
                    inputPrice: price.input,
                    outputPrice: price.output,
                    cacheReadPrice: price.cacheRead,
                  }
                : {}),
            },
          }),
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
          {shown.map((name) => {
            const price = available.data?.prices[name];
            return (
              <label key={name} className="flex items-center gap-2.5 font-mono text-[13px]">
                <input
                  type="checkbox"
                  className="size-4 accent-accent"
                  checked={chosen.includes(name)}
                  onChange={(e) =>
                    setChosen(
                      e.target.checked ? [...chosen, name] : chosen.filter((n) => n !== name),
                    )
                  }
                />
                <span className="min-w-0 truncate">{name}</span>
                {price && (
                  <span className="ml-auto shrink-0 font-sans text-xs text-muted">
                    {m.models.perMillion(fmtUsd(price.input), fmtUsd(price.output))}
                  </span>
                )}
              </label>
            );
          })}
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
      inputPrice?: number | null;
      outputPrice?: number | null;
      cacheReadPrice?: number | null;
      enabled?: boolean;
    }) => unwrap(api.models[':id'].$patch({ param: { id: model.id }, json })),
    onSuccess: onChange,
  });
  const remove = useMutation({
    mutationFn: () => unwrap(api.models[':id'].$delete({ param: { id: model.id } })),
    onSuccess: onChange,
  });
  const labels = {
    inputPrice: m.models.inputLabel,
    outputPrice: m.models.outputLabel,
    cacheReadPrice: m.models.cachedLabel,
  };
  // An empty field means "not set"; 0 means the model is free.
  const price = (field: 'inputPrice' | 'outputPrice' | 'cacheReadPrice') => (
    <Input
      // Re-mounts when the value changes elsewhere, e.g. "Use list price".
      key={`${field}:${model[field]}`}
      aria-label={labels[field](model.name)}
      mono
      type="number"
      min="0"
      step="any"
      disabled={model.isLocal}
      defaultValue={model[field] ?? ''}
      placeholder={
        model.isLocal
          ? '0'
          : field === 'cacheReadPrice'
            ? String(Math.round((model.inputPrice ?? 0) * 0.1 * 1e6) / 1e6)
            : m.models.notSet
      }
      className="h-8 text-right"
      onBlur={(e) => {
        const raw = e.target.value.trim();
        const value = raw === '' ? null : Number(raw);
        if (value !== model[field]) update.mutate({ [field]: value });
      }}
    />
  );
  const unpriced = !model.isLocal && (model.inputPrice === null || model.outputPrice === null);
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
    <div
      className={cx(
        MODEL_GRID,
        'items-center border-b border-line-soft py-2 text-sm last:border-0',
      )}
    >
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
      {price('cacheReadPrice')}
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
      {unpriced && (
        <div className="col-span-full -mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md bg-warn-bg px-3 py-1.5 text-[13px] text-warn-fg">
          <span>{m.models.noPrice}</span>
          {model.listPrice && (
            <button
              type="button"
              disabled={update.isPending}
              onClick={() =>
                model.listPrice &&
                update.mutate({
                  inputPrice: model.listPrice.input,
                  outputPrice: model.listPrice.output,
                  cacheReadPrice: model.listPrice.cacheRead,
                })
              }
              className="cursor-pointer font-medium underline underline-offset-2 hover:no-underline"
            >
              {m.models.applyListPrice(
                fmtUsd(model.listPrice.input),
                fmtUsd(model.listPrice.output),
              )}
            </button>
          )}
        </div>
      )}
      {(update.error || remove.error) && (
        <div className="col-span-full">
          <ErrorNote error={update.error ?? remove.error} />
        </div>
      )}
    </div>
  );
}
