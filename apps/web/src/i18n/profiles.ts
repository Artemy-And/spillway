import type { TraceParams } from './helpers.ts';

const en = {
  title: 'Routing profiles',
  subtitle: 'Apply a tested model choice to one gateway key and follow its costs.',
  empty: 'No profiles yet. Complete a model comparison to create one.',
  comparisons: 'Compare models',
  applyTitle: 'Apply to real requests',
  applyHint:
    'Requests for the baseline model on this key will use the candidate. Only supported text requests qualify; tools, images and stateful requests keep their original model.',
  proofHint:
    'Both models passed every tested task. This does not guarantee quality on other tasks.',
  unavailable:
    'Apply becomes available when the baseline and a cheaper candidate pass every task with known costs. Review manual answers first.',
  name: 'Profile name',
  key: 'Gateway key',
  baseline: 'Baseline',
  candidate: 'Tested cheaper model',
  apply: 'Apply to key',
  enabled: 'Enabled',
  fallback: 'Fallback to baseline on provider errors',
  fallbackHint:
    'Retries eligible failures before any answer is sent, subject to key limits and privacy rules. The baseline can cost more; a failed cloud attempt may also be charged. Existing gateway fallback rules still apply.',
  delete: 'Remove profile',
  deleteConfirm: 'Remove this profile? Future requests will use the original routing rules.',
  source: 'Source comparison',
  window: 'Last 30 days · recorded requests',
  spend: 'Recorded API spend',
  estimated: 'Estimated avoided baseline cost',
  estimateHint:
    'Estimated with candidate token usage at baseline prices. It is not a measured baseline bill. Cache hits, fallback and unknown usage are excluded; negative values mean estimated additional cost.',
  requests: 'Requests',
  selected: 'Candidate served',
  fallbacks: 'Fallback attempts',
  skipped: 'Original model kept',
  errors: 'Errors',
  eligible: 'Requests with a cost estimate',
  unknown: 'Requests with unknown charges',
  unknownHint:
    'Recorded spend may be incomplete when a provider omits usage or a failed cloud attempt may be charged.',
  revoked: 'Key revoked',
  traceApplied: 'Profile {profile} selected {model}',
  traceSkipped: 'Profile {profile} kept the original model: {reason}',
  traceFallback: 'Profile {profile}: selected provider failed → baseline {model}',
  skipReasons: {
    unsupported: 'unsupported request capabilities',
    unavailable: 'candidate unavailable',
    changed: 'model configuration changed',
    permission: 'candidate not allowed for this key or team',
  },
};
type Catalog = typeof en;

export const profileErrors: Record<string, Record<string, string>> = {
  en: {
    'Choose a completed comparison': 'Choose a completed comparison',
    'Choose different baseline and candidate models':
      'Choose different baseline and candidate models',
    'Choose models from this comparison': 'Choose models from this comparison',
    'Both models must pass every task with known costs':
      'Both models must pass every task with known costs',
    'The candidate must cost less on the tested tasks':
      'The candidate must cost less on the tested tasks',
    'Choose an active gateway key': 'Choose an active gateway key',
    'The selected key must allow both models': 'The selected key must allow both models',
    'Model configuration changed; run a new comparison':
      'Model configuration changed; run a new comparison',
    'This key already has a profile; remove it before applying a new one':
      'This key already has a profile; remove it before applying a new one',
    'Routing profile not found': 'Routing profile not found',
    'Routing profile could not be saved': 'Routing profile could not be saved',
  },
  ru: {
    'Choose a completed comparison': 'Выберите завершённое сравнение',
    'Choose different baseline and candidate models': 'Выберите разные базовую модель и кандидата',
    'Choose models from this comparison': 'Выберите модели из этого сравнения',
    'Both models must pass every task with known costs':
      'Обе модели должны пройти все задачи с известной стоимостью',
    'The candidate must cost less on the tested tasks':
      'Кандидат должен стоить дешевле на проверенных задачах',
    'Choose an active gateway key': 'Выберите действующий ключ шлюза',
    'The selected key must allow both models': 'Выбранный ключ должен разрешать обе модели',
    'Model configuration changed; run a new comparison':
      'Конфигурация модели изменилась; запустите новое сравнение',
    'This key already has a profile; remove it before applying a new one':
      'У ключа уже есть профиль; удалите его перед применением нового',
    'Routing profile not found': 'Профиль маршрутизации не найден',
    'Routing profile could not be saved': 'Не удалось сохранить профиль маршрутизации',
  },
  de: {
    'Choose a completed comparison': 'Abgeschlossenen Vergleich wählen',
    'Choose different baseline and candidate models':
      'Unterschiedliche Basis- und Kandidatenmodelle wählen',
    'Choose models from this comparison': 'Modelle aus diesem Vergleich wählen',
    'Both models must pass every task with known costs':
      'Beide Modelle müssen alle Aufgaben mit bekannten Kosten bestehen',
    'The candidate must cost less on the tested tasks':
      'Der Kandidat muss bei den getesteten Aufgaben günstiger sein',
    'Choose an active gateway key': 'Aktiven Gateway-Schlüssel wählen',
    'The selected key must allow both models': 'Der Schlüssel muss beide Modelle erlauben',
    'Model configuration changed; run a new comparison':
      'Modellkonfiguration geändert; neuen Vergleich starten',
    'This key already has a profile; remove it before applying a new one':
      'Dieser Schlüssel hat bereits ein Profil; zuerst entfernen',
    'Routing profile not found': 'Routingprofil nicht gefunden',
    'Routing profile could not be saved': 'Routingprofil konnte nicht gespeichert werden',
  },
  fr: {
    'Choose a completed comparison': 'Choisissez une comparaison terminée',
    'Choose different baseline and candidate models': 'Choisissez deux modèles différents',
    'Choose models from this comparison': 'Choisissez les modèles de cette comparaison',
    'Both models must pass every task with known costs':
      'Les deux modèles doivent réussir toutes les tâches avec des coûts connus',
    'The candidate must cost less on the tested tasks':
      'Le candidat doit coûter moins cher sur les tâches testées',
    'Choose an active gateway key': 'Choisissez une clé de passerelle active',
    'The selected key must allow both models': 'La clé doit autoriser les deux modèles',
    'Model configuration changed; run a new comparison':
      'Configuration modifiée ; relancez une comparaison',
    'This key already has a profile; remove it before applying a new one':
      'Cette clé a déjà un profil ; supprimez-le avant d’en appliquer un autre',
    'Routing profile not found': 'Profil de routage introuvable',
    'Routing profile could not be saved': 'Impossible d’enregistrer le profil',
  },
  es: {
    'Choose a completed comparison': 'Elige una comparación completada',
    'Choose different baseline and candidate models': 'Elige modelos base y candidato distintos',
    'Choose models from this comparison': 'Elige modelos de esta comparación',
    'Both models must pass every task with known costs':
      'Ambos modelos deben superar todas las tareas con costes conocidos',
    'The candidate must cost less on the tested tasks':
      'El candidato debe costar menos en las tareas probadas',
    'Choose an active gateway key': 'Elige una clave de pasarela activa',
    'The selected key must allow both models': 'La clave debe permitir ambos modelos',
    'Model configuration changed; run a new comparison':
      'Configuración modificada; ejecuta una nueva comparación',
    'This key already has a profile; remove it before applying a new one':
      'La clave ya tiene un perfil; elimínalo antes de aplicar otro',
    'Routing profile not found': 'Perfil de enrutamiento no encontrado',
    'Routing profile could not be saved': 'No se pudo guardar el perfil',
  },
  zh: {
    'Choose a completed comparison': '请选择已完成的对比',
    'Choose different baseline and candidate models': '请选择不同的基准和候选模型',
    'Choose models from this comparison': '请选择此对比中的模型',
    'Both models must pass every task with known costs': '两个模型必须通过所有任务且费用已知',
    'The candidate must cost less on the tested tasks': '候选模型在测试任务上的费用必须更低',
    'Choose an active gateway key': '请选择有效的网关密钥',
    'The selected key must allow both models': '密钥必须允许两个模型',
    'Model configuration changed; run a new comparison': '模型配置已更改，请重新对比',
    'This key already has a profile; remove it before applying a new one':
      '此密钥已有配置，请先删除再应用新配置',
    'Routing profile not found': '找不到路由配置',
    'Routing profile could not be saved': '无法保存路由配置',
  },
};

export const profileMessages: Record<'en' | 'ru' | 'de' | 'fr' | 'es' | 'zh', Catalog> = {
  en,
  ru: {
    title: 'Профили маршрутизации',
    subtitle: 'Примените проверенную модель к одному ключу и следите за расходами.',
    empty: 'Профилей пока нет. Завершите сравнение моделей, чтобы создать профиль.',
    comparisons: 'Сравнить модели',
    applyTitle: 'Применить к реальным запросам',
    applyHint:
      'Запросы к базовой модели с этим ключом пойдут кандидату. Подходят только поддерживаемые текстовые запросы; инструменты, изображения и запросы с сохранённым контекстом сохранят исходную модель.',
    proofHint:
      'Обе модели прошли все проверенные задачи. Это не гарантирует качество на других задачах.',
    unavailable:
      'Применение доступно, когда базовая модель и более дешёвый кандидат прошли все задачи с известной стоимостью. Сначала оцените ответы с ручной проверкой.',
    name: 'Название профиля',
    key: 'Ключ шлюза',
    baseline: 'Базовая модель',
    candidate: 'Проверенная более дешёвая модель',
    apply: 'Применить к ключу',
    enabled: 'Включён',
    fallback: 'Резервная базовая модель при сбое провайдера',
    fallbackHint:
      'Повторяет подходящие запросы до отправки ответа с учётом лимитов и правил защиты данных. Базовая модель может стоить дороже; неудачный облачный вызов тоже может быть платным. Общие правила резервной маршрутизации шлюза продолжают действовать.',
    delete: 'Удалить профиль',
    deleteConfirm:
      'Удалить профиль? Новые запросы будут использовать исходные правила маршрутизации.',
    source: 'Исходное сравнение',
    window: 'Последние 30 дней · записанные запросы',
    spend: 'Записанные расходы на API',
    estimated: 'Оценка сэкономленных расходов',
    estimateHint:
      'Оценка по токенам кандидата и ценам базовой модели. Реальный счёт базовой модели не измеряется. Кэш, резервные вызовы и неизвестное использование исключены; отрицательное значение означает оценку дополнительных расходов.',
    requests: 'Запросы',
    selected: 'Ответы кандидата',
    fallbacks: 'Резервные попытки',
    skipped: 'Сохранена исходная модель',
    errors: 'Ошибки',
    eligible: 'Запросы с оценкой расходов',
    unknown: 'Запросы с неизвестными расходами',
    unknownHint:
      'Записанные расходы могут быть неполными, если провайдер не сообщает токены или выставляет счёт за неудачный облачный вызов.',
    revoked: 'Ключ отозван',
    traceApplied: 'Профиль {profile} выбрал {model}',
    traceSkipped: 'Профиль {profile} сохранил исходную модель: {reason}',
    traceFallback: 'Профиль {profile}: сбой выбранного провайдера → базовая модель {model}',
    skipReasons: {
      unsupported: 'возможности запроса не поддерживаются профилем',
      unavailable: 'кандидат недоступен',
      changed: 'конфигурация модели изменилась',
      permission: 'кандидат запрещён для ключа или команды',
    },
  },
  de: {
    title: 'Routingprofile',
    subtitle: 'Eine getestete Modellwahl auf einen Schlüssel anwenden und Kosten verfolgen.',
    empty: 'Noch keine Profile. Erstellen Sie zuerst einen abgeschlossenen Modellvergleich.',
    comparisons: 'Modelle vergleichen',
    applyTitle: 'Auf echte Anfragen anwenden',
    applyHint:
      'Anfragen an das Basismodell mit diesem Schlüssel verwenden den Kandidaten. Nur unterstützte Textanfragen sind geeignet; Tools, Bilder und zustandsbehaftete Anfragen behalten ihr Modell.',
    proofHint:
      'Beide Modelle haben alle getesteten Aufgaben bestanden. Dies garantiert keine Qualität bei anderen Aufgaben.',
    unavailable:
      'Verfügbar, wenn Basis und günstigerer Kandidat alle Aufgaben mit bekannten Kosten bestehen. Manuelle Antworten zuerst bewerten.',
    name: 'Profilname',
    key: 'Gateway-Schlüssel',
    baseline: 'Basismodell',
    candidate: 'Getestetes günstigeres Modell',
    apply: 'Auf Schlüssel anwenden',
    enabled: 'Aktiviert',
    fallback: 'Bei Anbieterfehlern auf Basismodell ausweichen',
    fallbackHint:
      'Wiederholt geeignete Fehler vor der ersten Antwort unter Beachtung von Limits und Datenschutz. Die Basis kann teurer sein; auch ein fehlgeschlagener Cloud-Aufruf kann berechnet werden. Bestehende Gateway-Ausweichregeln gelten weiterhin.',
    delete: 'Profil entfernen',
    deleteConfirm: 'Profil entfernen? Neue Anfragen verwenden die ursprünglichen Routingregeln.',
    source: 'Quellvergleich',
    window: 'Letzte 30 Tage · erfasste Anfragen',
    spend: 'Erfasste API-Kosten',
    estimated: 'Geschätzte vermiedene Basiskosten',
    estimateHint:
      'Geschätzt anhand der Kandidatentokens zu Basispreisen, keine gemessene Basisrechnung. Cache, Ausweichanfragen und unbekannte Nutzung sind ausgeschlossen; negative Werte bedeuten geschätzte Mehrkosten.',
    requests: 'Anfragen',
    selected: 'Kandidatenantworten',
    fallbacks: 'Ausweichversuche',
    skipped: 'Ursprüngliches Modell behalten',
    errors: 'Fehler',
    eligible: 'Anfragen mit Kostenschätzung',
    unknown: 'Anfragen mit unbekannten Kosten',
    unknownHint:
      'Erfasste Kosten können unvollständig sein, wenn Nutzung fehlt oder fehlgeschlagene Cloud-Versuche berechnet werden.',
    revoked: 'Schlüssel widerrufen',
    traceApplied: 'Profil {profile} wählte {model}',
    traceSkipped: 'Profil {profile} behielt das ursprüngliche Modell: {reason}',
    traceFallback: 'Profil {profile}: Anbieterfehler → Basis {model}',
    skipReasons: {
      unsupported: 'nicht unterstützte Anfragefunktionen',
      unavailable: 'Kandidat nicht verfügbar',
      changed: 'Modellkonfiguration geändert',
      permission: 'Kandidat für Schlüssel oder Team nicht erlaubt',
    },
  },
  fr: {
    title: 'Profils de routage',
    subtitle: 'Appliquez un choix de modèle testé à une clé et suivez ses coûts.',
    empty: 'Aucun profil. Terminez une comparaison de modèles pour en créer un.',
    comparisons: 'Comparer les modèles',
    applyTitle: 'Appliquer aux requêtes réelles',
    applyHint:
      'Les requêtes au modèle de référence avec cette clé utiliseront le candidat. Seules les requêtes textuelles compatibles sont concernées ; outils, images et requêtes avec état conservent leur modèle.',
    proofHint:
      'Les deux modèles ont réussi toutes les tâches testées. Cela ne garantit pas la qualité sur les autres tâches.',
    unavailable:
      'Disponible lorsque la référence et un candidat moins cher réussissent toutes les tâches avec des coûts connus. Évaluez d’abord les réponses manuelles.',
    name: 'Nom du profil',
    key: 'Clé de passerelle',
    baseline: 'Référence',
    candidate: 'Modèle moins cher testé',
    apply: 'Appliquer à la clé',
    enabled: 'Activé',
    fallback: 'Revenir à la référence en cas d’erreur du fournisseur',
    fallbackHint:
      'Réessaie les erreurs admissibles avant toute réponse, en respectant les limites et la confidentialité. La référence peut coûter plus cher ; une tentative cloud échouée peut aussi être facturée. Les règles de secours de la passerelle restent actives.',
    delete: 'Supprimer le profil',
    deleteConfirm: 'Supprimer ce profil ? Les prochaines requêtes suivront les règles initiales.',
    source: 'Comparaison source',
    window: '30 derniers jours · requêtes enregistrées',
    spend: 'Dépenses API enregistrées',
    estimated: 'Coût de référence évité estimé',
    estimateHint:
      'Estimation avec les jetons du candidat aux prix de référence, sans facture de référence mesurée. Cache, secours et usage inconnu sont exclus ; les valeurs négatives indiquent un surcoût estimé.',
    requests: 'Requêtes',
    selected: 'Réponses du candidat',
    fallbacks: 'Tentatives de secours',
    skipped: 'Modèle initial conservé',
    errors: 'Erreurs',
    eligible: 'Requêtes avec estimation',
    unknown: 'Requêtes aux coûts inconnus',
    unknownHint:
      'Les dépenses peuvent être incomplètes si l’usage manque ou si une tentative cloud échouée est facturée.',
    revoked: 'Clé révoquée',
    traceApplied: 'Le profil {profile} a choisi {model}',
    traceSkipped: 'Le profil {profile} a conservé le modèle initial : {reason}',
    traceFallback: 'Profil {profile} : erreur du fournisseur → référence {model}',
    skipReasons: {
      unsupported: 'fonctionnalités de requête non prises en charge',
      unavailable: 'candidat indisponible',
      changed: 'configuration du modèle modifiée',
      permission: 'candidat interdit pour cette clé ou équipe',
    },
  },
  es: {
    title: 'Perfiles de enrutamiento',
    subtitle: 'Aplica un modelo probado a una clave y sigue sus costes.',
    empty: 'Aún no hay perfiles. Completa una comparación de modelos para crear uno.',
    comparisons: 'Comparar modelos',
    applyTitle: 'Aplicar a solicitudes reales',
    applyHint:
      'Las solicitudes al modelo base con esta clave usarán el candidato. Solo admite solicitudes de texto compatibles; herramientas, imágenes y solicitudes con estado conservan su modelo.',
    proofHint:
      'Ambos modelos superaron todas las tareas probadas. Esto no garantiza calidad en otras tareas.',
    unavailable:
      'Disponible cuando la base y un candidato más barato superan todas las tareas con costes conocidos. Revisa primero las respuestas manuales.',
    name: 'Nombre del perfil',
    key: 'Clave de pasarela',
    baseline: 'Modelo base',
    candidate: 'Modelo más barato probado',
    apply: 'Aplicar a la clave',
    enabled: 'Activado',
    fallback: 'Volver al modelo base si falla el proveedor',
    fallbackHint:
      'Reintenta errores aptos antes de enviar una respuesta, respetando límites y privacidad. La base puede costar más; también puede cobrarse el intento fallido en la nube. Las reglas de respaldo de la pasarela siguen vigentes.',
    delete: 'Eliminar perfil',
    deleteConfirm: '¿Eliminar este perfil? Las nuevas solicitudes usarán las reglas originales.',
    source: 'Comparación de origen',
    window: 'Últimos 30 días · solicitudes registradas',
    spend: 'Gasto API registrado',
    estimated: 'Coste base evitado estimado',
    estimateHint:
      'Estimación con los tokens del candidato a precios base, sin medir la factura base. Se excluyen caché, respaldo y uso desconocido; valores negativos indican coste adicional estimado.',
    requests: 'Solicitudes',
    selected: 'Respuestas del candidato',
    fallbacks: 'Intentos de respaldo',
    skipped: 'Modelo original conservado',
    errors: 'Errores',
    eligible: 'Solicitudes con estimación',
    unknown: 'Solicitudes con costes desconocidos',
    unknownHint:
      'El gasto puede estar incompleto si falta el uso o se cobran intentos fallidos en la nube.',
    revoked: 'Clave revocada',
    traceApplied: 'El perfil {profile} seleccionó {model}',
    traceSkipped: 'El perfil {profile} conservó el modelo original: {reason}',
    traceFallback: 'Perfil {profile}: fallo del proveedor → base {model}',
    skipReasons: {
      unsupported: 'funciones de solicitud incompatibles',
      unavailable: 'candidato no disponible',
      changed: 'configuración del modelo modificada',
      permission: 'candidato no permitido para la clave o el equipo',
    },
  },
  zh: {
    title: '路由配置',
    subtitle: '将经过测试的模型选择应用到一个密钥并跟踪费用。',
    empty: '暂无配置。完成模型对比后即可创建。',
    comparisons: '对比模型',
    applyTitle: '应用到实际请求',
    applyHint:
      '使用此密钥请求基准模型时会调用候选模型。仅适用于支持的文本请求；工具、图片及有状态请求保留原模型。',
    proofHint: '两个模型均通过了所有测试任务。这不保证其他任务的质量。',
    unavailable:
      '基准模型及更便宜的候选模型通过所有任务且费用已知后才可应用。请先审核人工评估的回答。',
    name: '配置名称',
    key: '网关密钥',
    baseline: '基准模型',
    candidate: '经过测试的低成本模型',
    apply: '应用到密钥',
    enabled: '已启用',
    fallback: '供应商出错时回退到基准模型',
    fallbackHint:
      '在发送任何回答前重试符合条件的错误，并遵守限额与隐私规则。基准模型费用可能更高；失败的云端调用也可能收费。网关现有回退规则仍然有效。',
    delete: '删除配置',
    deleteConfirm: '删除此配置？新请求将使用原路由规则。',
    source: '来源对比',
    window: '最近30天 · 已记录的请求',
    spend: '已记录的 API 费用',
    estimated: '估算节省的基准费用',
    estimateHint:
      '按候选模型的令牌用量及基准价格估算，并非测量的基准账单。排除缓存、回退及未知用量；负值表示估算的额外费用。',
    requests: '请求数',
    selected: '候选模型回答',
    fallbacks: '回退尝试',
    skipped: '保留原模型',
    errors: '错误',
    eligible: '可估算费用的请求',
    unknown: '费用未知的请求',
    unknownHint: '供应商未报告用量或失败的云端调用收费时，已记录费用可能不完整。',
    revoked: '密钥已撤销',
    traceApplied: '配置 {profile} 选择了 {model}',
    traceSkipped: '配置 {profile} 保留了原模型：{reason}',
    traceFallback: '配置 {profile}：供应商失败 → 基准模型 {model}',
    skipReasons: {
      unsupported: '不支持的请求功能',
      unavailable: '候选模型不可用',
      changed: '模型配置已更改',
      permission: '密钥或团队不允许使用候选模型',
    },
  },
};

export function profileTrace(
  catalog: Catalog,
  kind: 'traceApplied' | 'traceSkipped' | 'traceFallback',
  params: TraceParams,
): string {
  const reason =
    params.reason && catalog.skipReasons[params.reason as keyof Catalog['skipReasons']];
  const values = { ...params, reason: reason ?? params.reason };
  return catalog[kind].replace(/\{(\w+)\}/g, (_, key: keyof typeof values) =>
    String(values[key] ?? ''),
  );
}
