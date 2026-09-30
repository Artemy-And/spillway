import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { PlusIcon, TrashIcon } from '../components/icons.tsx';
import {
  Button,
  Card,
  Chip,
  Empty,
  ErrorNote,
  Field,
  Input,
  PageHeader,
  Select,
  Switch,
} from '../components/ui.tsx';
import { api, type ModelRow, modelsQuery, type ProviderRow, unwrap } from '../lib/api.ts';
import { plural } from '../lib/format.ts';

type Kind = 'openai' | 'anthropic' | 'ollama';

const KINDS: Record<Kind, { label: string; baseUrl: string; hint: string }> = {
  openai: {
    label: 'OpenAI-compatible',
    baseUrl: 'https://api.openai.com/v1',
    hint: 'OpenAI, OpenRouter, vLLM, LM Studio, YandexGPT and other /v1/chat/completions APIs',
  },
  anthropic: {
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    hint: 'Claude models through the Messages API',
  },
  ollama: {
    label: 'Ollama',
    baseUrl: 'http://ollama:11434',
    hint: 'Local models; no API key needed',
  },
};

export function ModelsPage() {
  const queryClient = useQueryClient();
  const { data: providers = [] } = useQuery({
    queryKey: ['providers'],
    queryFn: () => unwrap(api.providers.$get()),
  });
  const { data: models = [] } = useQuery(modelsQuery);
  const [adding, setAdding] = useState(false);
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
      <PageHeader
        title="Models & providers"
        subtitle="Where requests go, and the model names your people and agents use."
      >
        <Button variant="primary" onClick={() => setAdding(true)}>
          <PlusIcon strokeWidth={2.2} />
          Add provider
        </Button>
      </PageHeader>

      {adding && (
        <NewProvider
          onDone={async () => {
            await refresh();
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      )}

      <section
        aria-label="Providers"
        className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3"
      >
        {providers.length === 0 && !adding && (
          <Card className="lg:col-span-2">
            <Empty>
              No providers yet. Add Ollama for local models, or a cloud API with its key.
            </Empty>
          </Card>
        )}
        {providers.map((provider) => (
          <Card key={provider.id} className="flex flex-col gap-3 px-6 py-5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-col gap-1">
                <h2 className="text-[15px] font-semibold">{provider.name}</h2>
                <div className="flex flex-wrap gap-1.5">
                  <Chip>{KINDS[provider.kind].label}</Chip>
                  {provider.isLocal && <Chip>Local · free</Chip>}
                  {provider.kind !== 'ollama' && (
                    <Chip>{provider.hasApiKey ? 'API key set' : 'No API key'}</Chip>
                  )}
                </div>
              </div>
              <button
                type="button"
                aria-label={`Delete ${provider.name}`}
                onClick={() =>
                  confirm(`Delete ${provider.name} and its models?`) &&
                  removeProvider.mutate(provider.id)
                }
                className="flex size-9 cursor-pointer items-center justify-center rounded-md text-muted hover:bg-block-bg hover:text-block-fg"
              >
                <TrashIcon />
              </button>
            </div>
            <div className="truncate font-mono text-xs text-muted">{provider.baseUrl}</div>
            <div className="text-[13px] text-ink-2">
              {plural(models.filter((m) => m.providerId === provider.id).length, 'model')}
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
                Add models
              </Button>
            )}
          </Card>
        ))}
      </section>
      <ErrorNote error={removeProvider.error} />

      <Card aria-label="Models" className="overflow-x-auto px-6 py-4">
        <h2 className="mb-1 text-[15px] font-semibold">Models</h2>
        <p className="mb-3 text-[13px] text-muted">
          Clients send the name in the <code className="font-mono">model</code> field. Prices are
          USD per million tokens; they drive budgets and savings.
        </p>
        <div className="min-w-[860px]">
          <div className="grid grid-cols-[1.4fr_1.2fr_1fr_1.4fr_0.8fr_0.8fr_90px_40px] gap-3 border-b border-line py-2.5 text-xs font-medium text-muted">
            <div>Name clients use</div>
            <div>Display name</div>
            <div>Provider</div>
            <div>Upstream model</div>
            <div className="text-right">Input $/1M</div>
            <div className="text-right">Output $/1M</div>
            <div>Enabled</div>
            <div />
          </div>
          {models.length === 0 && <Empty>No models yet. Use “Add models” on a provider.</Empty>}
          {models.map((model) => (
            <ModelLine key={model.id} model={model} onChange={refresh} />
          ))}
        </div>
      </Card>
    </>
  );
}

function NewProvider({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [kind, setKind] = useState<Kind>('ollama');
  const [name, setName] = useState('Ollama');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [isLocal, setIsLocal] = useState(true);
  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.providers.$post({
          json: {
            name: name.trim(),
            kind,
            baseUrl: baseUrl.trim() || undefined,
            apiKey: apiKey.trim() || undefined,
            isLocal,
          },
        }),
      ),
    onSuccess: onDone,
  });
  return (
    <Card className="px-6 py-5">
      <form
        className="grid grid-cols-1 gap-4 md:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <h2 className="text-[17px] font-semibold md:col-span-2">New provider</h2>
        <Field label="Type" hint={KINDS[kind].hint}>
          <Select
            value={kind}
            onChange={(e) => {
              const next = e.target.value as Kind;
              setKind(next);
              setIsLocal(next === 'ollama');
              if (
                Object.values(KINDS).some((k) => k.label === name) ||
                ['Ollama', 'Anthropic', 'OpenAI'].includes(name)
              ) {
                setName(next === 'openai' ? 'OpenAI' : KINDS[next].label);
              }
            }}
          >
            {(Object.keys(KINDS) as Kind[]).map((k) => (
              <option key={k} value={k}>
                {KINDS[k].label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Name">
          <Input required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Base URL">
          <Input
            mono
            placeholder={KINDS[kind].baseUrl}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </Field>
        <Field label="API key" hint="Encrypted at rest with the gateway secret.">
          <Input
            mono
            type="password"
            autoComplete="off"
            placeholder={kind === 'ollama' ? 'not needed' : 'sk-…'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </Field>
        <div className="md:col-span-2">
          <Switch
            checked={isLocal}
            onChange={setIsLocal}
            label="Runs on our own hardware"
            description="Local models cost nothing, skip budgets and may receive prompts with personal data."
          />
        </div>
        <div className="md:col-span-2">
          <ErrorNote error={create.error} />
        </div>
        <div className="flex justify-end gap-2.5 md:col-span-2">
          <Button onClick={onCancel}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={create.isPending}>
            Add provider
          </Button>
        </div>
      </form>
    </Card>
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
  const options = (available.data?.models ?? []).filter((m) => !taken.has(m));

  return (
    <div className="flex flex-col gap-3 rounded-lg bg-canvas p-3">
      {available.isLoading && (
        <p className="text-[13px] text-muted">Asking {provider.name} for its models…</p>
      )}
      {available.error && <ErrorNote error={available.error} />}
      {options.length > 0 && (
        <div className="flex max-h-56 flex-col gap-1.5 overflow-y-auto">
          {options.map((name) => (
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
        <p className="text-[13px] text-muted">
          Every model {provider.name} lists is already added.
        </p>
      )}
      <Field label="Or type model ids, comma-separated">
        <Input
          mono
          placeholder="claude-sonnet-4-5, gpt-5-mini"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
        />
      </Field>
      <ErrorNote error={add.error} />
      <div className="flex justify-end gap-2">
        <Button onClick={onDone}>Cancel</Button>
        <Button
          variant="primary"
          disabled={add.isPending || (!chosen.length && !manual.trim())}
          onClick={() => add.mutate()}
        >
          Add {chosen.length + manual.split(',').filter((s) => s.trim()).length || ''} models
        </Button>
      </div>
    </div>
  );
}

function ModelLine({ model, onChange }: { model: ModelRow; onChange: () => void }) {
  const update = useMutation({
    mutationFn: (json: {
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
      aria-label={`${model.name} ${field === 'inputPrice' ? 'input' : 'output'} price`}
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
  return (
    <div className="grid grid-cols-[1.4fr_1.2fr_1fr_1.4fr_0.8fr_0.8fr_90px_40px] items-center gap-3 border-b border-line-soft py-2 text-sm last:border-0">
      <span className="truncate font-mono text-[13px] font-medium" title={model.name}>
        {model.name}
      </span>
      <Input
        aria-label={`${model.name} display name`}
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
        {model.isLocal && <span className="text-muted"> · local</span>}
      </span>
      <span className="truncate font-mono text-xs text-muted" title={model.upstreamModel}>
        {model.upstreamModel}
      </span>
      {price('inputPrice')}
      {price('outputPrice')}
      <input
        type="checkbox"
        aria-label={`${model.name} enabled`}
        checked={model.enabled}
        onChange={(e) => update.mutate({ enabled: e.target.checked })}
        className="size-4 accent-accent"
      />
      <button
        type="button"
        aria-label={`Delete ${model.name}`}
        onClick={() => confirm(`Delete ${model.name}?`) && remove.mutate()}
        className="flex size-8 cursor-pointer items-center justify-center rounded-md text-muted hover:bg-block-bg hover:text-block-fg"
      >
        <TrashIcon />
      </button>
    </div>
  );
}
