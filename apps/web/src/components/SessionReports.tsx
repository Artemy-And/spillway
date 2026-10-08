import { useQuery } from '@tanstack/react-query';
import { useI18n } from '../i18n/index.tsx';
import { api, unwrap } from '../lib/api.ts';
import { Card, Empty, ErrorNote } from './ui.tsx';

const messages = {
  en: [
    'Agent sessions',
    'Latest 50 retained bindings. Tokens and latency cover logged calls; spend/reserves come from the charge ledger. Slow calls: ≥5 s.',
    'Session / key',
    'Model',
    'Calls / active',
    'Input / output tokens',
    'Recorded spend',
    'Active / uncertain reserve',
    'Errors / slow calls',
    'Average / max latency',
    'Unknown usage',
    'Unknown charges',
    'No sessions yet',
  ],
  ru: [
    'Агентские сессии',
    'Последние 50 сохранённых привязок. Токены и задержки — по записанным вызовам; расходы и резервы — из журнала списаний. Медленные вызовы: ≥5 с.',
    'Сессия / ключ',
    'Модель',
    'Вызовы / активные',
    'Токены вход / выход',
    'Учтённые расходы',
    'Активный / неопределённый резерв',
    'Ошибки / медленные вызовы',
    'Средняя / макс. задержка',
    'Токены неизвестны',
    'Расходы неизвестны',
    'Сессий пока нет',
  ],
  de: [
    'Agentensitzungen',
    'Letzte 50 gespeicherte Bindungen. Tokens/Latenz aus protokollierten Aufrufen; Kosten/Reserven aus dem Abrechnungsbuch. Langsame Aufrufe: ≥5 s.',
    'Sitzung / Schlüssel',
    'Modell',
    'Aufrufe / aktiv',
    'Eingabe- / Ausgabetokens',
    'Erfasste Kosten',
    'Aktive / ungewisse Reserve',
    'Fehler / langsame Aufrufe',
    'Mittlere / maximale Latenz',
    'Tokenverbrauch unbekannt',
    'Kosten unbekannt',
    'Noch keine Sitzungen',
  ],
  fr: [
    'Sessions des agents',
    '50 dernières liaisons conservées. Tokens/latence des appels journalisés ; coûts/réserves du registre. Appels lents : ≥5 s.',
    'Session / clé',
    'Modèle',
    'Appels / actifs',
    'Tokens entrée / sortie',
    'Coût enregistré',
    'Réserve active / incertaine',
    'Erreurs / appels lents',
    'Latence moyenne / max.',
    'Usage inconnu',
    'Coûts inconnus',
    'Aucune session',
  ],
  es: [
    'Sesiones de agentes',
    'Últimas 50 vinculaciones conservadas. Tokens/latencia de llamadas registradas; costes/reservas del libro de cargos. Llamadas lentas: ≥5 s.',
    'Sesión / clave',
    'Modelo',
    'Llamadas / activas',
    'Tokens entrada / salida',
    'Coste registrado',
    'Reserva activa / incierta',
    'Errores / llamadas lentas',
    'Latencia media / máx.',
    'Uso desconocido',
    'Costes desconocidos',
    'Sin sesiones todavía',
  ],
  zh: [
    '代理会话',
    '最近50个保留绑定。令牌和延迟来自已记录调用；费用和预留来自计费账本。慢调用：≥5秒。',
    '会话 / 密钥',
    '模型',
    '调用 / 活跃',
    '输入 / 输出令牌',
    '已记录费用',
    '活跃 / 不确定预留',
    '错误 / 慢调用',
    '平均 / 最大延迟',
    '用量未知',
    '费用未知',
    '暂无会话',
  ],
};

export function SessionReports() {
  const { locale } = useI18n();
  const t = messages[locale];
  const rows = useQuery({
    queryKey: ['routing-session-reports'],
    queryFn: () => unwrap(api['routing-profiles'].sessions.$get()),
    refetchInterval: 10_000,
  });
  const money = (value: number) =>
    new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 6,
    }).format(value);
  return (
    <Card className="space-y-3 p-5">
      <h2 className="text-lg font-semibold">{t[0]}</h2>
      <p className="text-xs text-muted">{t[1]}</p>
      <ErrorNote error={rows.error} />
      {rows.data?.length === 0 ? (
        <Empty>{t[12]}</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1000px] text-left text-sm">
            <thead>
              <tr>
                {t.slice(2, 10).map((label) => (
                  <th key={label} className="p-2 font-medium text-muted">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.data?.map((row) => (
                <tr key={row.id} className="border-t border-line">
                  <td className="p-2">
                    <span className="font-mono" title={row.id}>
                      {row.id.slice(0, 12)}
                    </span>
                    <div className="text-xs text-muted">{row.keyName}</div>
                  </td>
                  <td className="p-2">
                    {row.selector} → {row.model}
                  </td>
                  <td className="p-2">
                    {row.requests} / {row.activeRequests}
                  </td>
                  <td className="p-2">
                    {row.inputTokens} / {row.outputTokens}
                    {row.unknownUsage > 0 && (
                      <div className="text-xs text-warn-fg">
                        {t[10]}: {row.unknownUsage}
                      </div>
                    )}
                  </td>
                  <td className="p-2">
                    {money(row.recordedSpendUsd)}
                    {row.unknownCosts > 0 && (
                      <div className="text-xs text-warn-fg">
                        {t[11]}: {row.unknownCosts}
                      </div>
                    )}
                  </td>
                  <td className="p-2">
                    {money(row.activeReserveUsd)} / {money(row.uncertainReserveUsd)}
                  </td>
                  <td className="p-2">
                    {row.errors} / {row.slowRequests}
                  </td>
                  <td className="p-2">
                    {Math.round(row.averageLatencyMs)} / {row.maxLatencyMs} ms
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
