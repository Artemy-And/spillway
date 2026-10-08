import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useI18n } from '../i18n/index.tsx';
import { api, meQuery, modelsQuery, unwrap } from '../lib/api.ts';
import { Button, Card, ErrorNote, Field, Input, Select } from './ui.tsx';

const messages = {
  en: [
    'Model aliases and pools',
    'Use one model name; each new tool session keeps its first selection. Send x-spillway-session from the first turn.',
    'Name',
    'Weighted selection',
    'Lowest token price',
    'Targets and weights',
    'Save',
    'Edit',
    'Remove',
  ],
  ru: [
    'Алиасы моделей и пулы',
    'Используйте одно имя модели; новая сессия с инструментами сохраняет первый выбор. Передавайте x-spillway-session с первого хода.',
    'Имя',
    'Выбор по весам',
    'Минимальная цена токенов',
    'Модели и веса',
    'Сохранить',
    'Изменить',
    'Удалить',
  ],
  de: [
    'Modell-Aliasse und Pools',
    'Ein Modellname; neue Werkzeugsitzungen behalten ihre erste Auswahl. x-spillway-session ab dem ersten Schritt senden.',
    'Name',
    'Gewichtete Auswahl',
    'Niedrigster Tokenpreis',
    'Modelle und Gewichte',
    'Speichern',
    'Bearbeiten',
    'Entfernen',
  ],
  fr: [
    'Alias et pools de modèles',
    'Un seul nom ; chaque nouvelle session conserve son premier choix. Envoyez x-spillway-session dès le premier tour.',
    'Nom',
    'Sélection pondérée',
    'Prix par token minimal',
    'Modèles et poids',
    'Enregistrer',
    'Modifier',
    'Supprimer',
  ],
  es: [
    'Alias y grupos de modelos',
    'Un nombre; cada sesión nueva conserva su primera selección. Envía x-spillway-session desde el primer turno.',
    'Nombre',
    'Selección ponderada',
    'Precio mínimo por token',
    'Modelos y pesos',
    'Guardar',
    'Editar',
    'Eliminar',
  ],
  zh: [
    '模型别名与池',
    '使用一个模型名称；每个新工具会话保持首次选择。从首轮发送 x-spillway-session。',
    '名称',
    '加权选择',
    '最低令牌价格',
    '模型和权重',
    '保存',
    '编辑',
    '删除',
  ],
};

export function ModelAliases() {
  const { locale } = useI18n();
  const t = messages[locale];
  const cache = useQueryClient();
  const { data: me } = useQuery(meQuery);
  const { data: models = [] } = useQuery(modelsQuery);
  const aliases = useQuery({
    queryKey: ['model-aliases'],
    queryFn: () => unwrap(api['model-aliases'].$get()),
  });
  const [name, setName] = useState('');
  const [strategy, setStrategy] = useState<'weighted' | 'lowest-cost'>('weighted');
  const [targets, setTargets] = useState<{ modelId: string; weight: number }[]>([]);
  const refresh = () => cache.invalidateQueries({ queryKey: ['model-aliases'] });
  const save = useMutation({
    mutationFn: () =>
      unwrap(api['model-aliases'].$put({ json: { name, strategy, enabled: true, targets } })),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (name: string) =>
      unwrap(api['model-aliases'][':name'].$delete({ param: { name } })),
    onSuccess: refresh,
  });
  const disabled = save.isPending || remove.isPending || !!me?.gateway.demo;
  return (
    <Card className="space-y-4 p-5">
      <h2 className="text-lg font-semibold">{t[0]}</h2>
      <p className="text-sm text-muted">{t[1]}</p>
      <ErrorNote error={aliases.error ?? save.error ?? remove.error} />
      {aliases.data?.map((alias) => (
        <div key={alias.name} className="flex flex-wrap items-center gap-3 text-sm">
          <span className="font-medium">{alias.name}</span>
          <span className="text-muted">
            {alias.targets
              .map(
                (entry) =>
                  `${models.find((model) => model.id === entry.modelId)?.name ?? entry.modelId} (${entry.weight})`,
              )
              .join(', ')}
          </span>
          <Button
            disabled={disabled}
            onClick={() => {
              setName(alias.name);
              setStrategy(alias.strategy);
              setTargets(alias.targets);
            }}
          >
            {t[7]}
          </Button>
          <Button disabled={disabled} variant="danger" onClick={() => remove.mutate(alias.name)}>
            {t[8]}
          </Button>
        </div>
      ))}
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <Field label={t[2]!}>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={128}
            disabled={disabled}
          />
        </Field>
        <Select
          value={strategy}
          onChange={(e) => setStrategy(e.target.value as typeof strategy)}
          disabled={disabled}
          aria-label={t[0]}
        >
          <option value="weighted">{t[3]}</option>
          <option value="lowest-cost">{t[4]}</option>
        </Select>
        <fieldset disabled={disabled}>
          <legend className="text-sm text-muted">{t[5]}</legend>
          {models
            .filter((model) => model.enabled)
            .map((model) => {
              const entry = targets.find((target) => target.modelId === model.id);
              return (
                <label key={model.id} className="flex items-center gap-3 py-1 text-sm">
                  <input
                    type="checkbox"
                    checked={!!entry}
                    onChange={(e) =>
                      setTargets(
                        e.target.checked
                          ? [...targets, { modelId: model.id, weight: 1 }]
                          : targets.filter((target) => target.modelId !== model.id),
                      )
                    }
                  />
                  {model.name}
                  {entry && (
                    <Input
                      type="number"
                      min={1}
                      max={1000}
                      step={1}
                      value={entry.weight}
                      className="max-w-24"
                      aria-label={`${model.name}: ${t[5]}`}
                      onChange={(e) =>
                        setTargets(
                          targets.map((target) =>
                            target.modelId === model.id
                              ? { ...target, weight: Number(e.target.value) }
                              : target,
                          ),
                        )
                      }
                    />
                  )}
                </label>
              );
            })}
        </fieldset>
        <Button
          type="submit"
          disabled={disabled || !name.trim() || !targets.length || targets.length > 16}
        >
          {t[6]}
        </Button>
      </form>
    </Card>
  );
}
