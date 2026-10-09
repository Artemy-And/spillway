const en = {
  toolsMode: 'Tool sessions',
  textMode: 'Text requests',
  rollout: 'New sessions using the candidate',
  rolloutHint:
    'Changing this share affects only new sessions. Set 0% to stop new candidate assignments while existing sessions keep their model.',
  activeSessions: 'Active tool sessions',
  applyHint:
    'Use the tested model for new sessions with matching tool definitions. Every session keeps its model.',
  connectionHint:
    'Send x-spillway-session with a new random ID from the first request, then reuse it on each turn. Supports Chat, Responses and Messages function calls with streaming for up to 24 hours.',
  nativeContextHint:
    'Native providers also support Responses continuation with store: true and previous_response_id, and unchanged Messages thinking blocks and signatures. Start a new conversation after an interrupted native turn.',
  fallbackHint:
    'Provider errors stop the request. Continuing on another model requires a new conversation.',
  newEvidence:
    'Run a complete tool-loop comparison with both models passing and known costs before applying tool routing.',
  profileHint:
    'Complete tool loops can create a session routing profile. Call-only checks cannot activate routing.',
  tracePinned: 'Session kept on {model}',
  traceBlocked: 'Session request blocked',
  traceKept: 'Session kept its model through a routing rule',
};
type Messages = typeof en;
export const sessionRoutingMessages: Record<'en' | 'ru' | 'de' | 'fr' | 'es' | 'zh', Messages> = {
  en,
  ru: {
    toolsMode: 'Сессии с инструментами',
    textMode: 'Текстовые запросы',
    rollout: 'Доля новых сессий на проверенной модели',
    rolloutHint:
      'Доля влияет только на новые сессии. 0% останавливает новые назначения кандидата; начатые сессии сохраняют модель.',
    activeSessions: 'Активные сессии с инструментами',
    applyHint:
      'Примените проверенную модель к новым сессиям с совпадающими определениями инструментов. Каждая сессия сохраняет свою модель.',
    connectionHint:
      'Передайте x-spillway-session с новым случайным ID с первого запроса и повторяйте его на каждом ходу. Поддерживаются вызовы функций Chat, Responses и Messages со стримингом, до 24 часов.',
    nativeContextHint:
      'Нативные провайдеры поддерживают продолжение Responses через store: true и previous_response_id, а также неизменённые thinking-блоки и подписи Messages. После обрыва нативного хода начните новый разговор.',
    fallbackHint:
      'При ошибке провайдера запрос останавливается. Продолжение на другой модели требует нового разговора.',
    newEvidence:
      'Для маршрутизации инструментов запустите сравнение полной цепочки: обе модели должны пройти проверки с известными расходами.',
    profileHint:
      'Полные цепочки позволяют создать профиль маршрутизации сессий. Проверки одного вызова не активируют маршрутизацию.',
    tracePinned: 'Сессия закреплена за {model}',
    traceBlocked: 'Запрос сессии заблокирован',
    traceKept: 'Сессия сохранила модель при срабатывании правила',
  },
  de: {
    toolsMode: 'Werkzeugsitzungen',
    textMode: 'Textanfragen',
    rollout: 'Neue Sitzungen mit dem Kandidaten',
    rolloutHint:
      'Änderungen betreffen nur neue Sitzungen. 0% stoppt neue Zuweisungen; bestehende Sitzungen behalten ihr Modell.',
    activeSessions: 'Aktive Werkzeugsitzungen',
    applyHint:
      'Das getestete Modell für neue Sitzungen mit passenden Werkzeugdefinitionen verwenden. Jede Sitzung behält ihr Modell.',
    connectionHint:
      'Ab der ersten Anfrage x-spillway-session mit einer neuen zufälligen ID senden und bei jedem Schritt wiederverwenden. Unterstützt Funktionsaufrufe über Chat, Responses und Messages mit Streaming für bis zu 24 Stunden.',
    nativeContextHint:
      'Native Anbieter unterstützen Responses mit store: true und previous_response_id sowie unveränderte Thinking-Blöcke und Signaturen in Messages. Nach einem unterbrochenen nativen Schritt eine neue Unterhaltung beginnen.',
    fallbackHint:
      'Anbieterfehler stoppen die Anfrage. Ein anderes Modell erfordert eine neue Unterhaltung.',
    newEvidence:
      'Vor Werkzeugrouting eine vollständige Werkzeugschleife vergleichen: beide Modelle müssen bei bekannten Kosten bestehen.',
    profileHint:
      'Vollständige Werkzeugschleifen können ein Sitzungsprofil erstellen. Einzelne Aufrufprüfungen aktivieren kein Routing.',
    tracePinned: 'Sitzung bleibt bei {model}',
    traceBlocked: 'Sitzungsanfrage blockiert',
    traceKept: 'Sitzung behielt ihr Modell trotz Routingregel',
  },
  fr: {
    toolsMode: 'Sessions avec outils',
    textMode: 'Requêtes textuelles',
    rollout: 'Nouvelles sessions utilisant le candidat',
    rolloutHint:
      'La part ne concerne que les nouvelles sessions. 0% arrête les nouvelles affectations ; les sessions existantes conservent leur modèle.',
    activeSessions: 'Sessions avec outils actives',
    applyHint:
      'Utilisez le modèle testé pour les nouvelles sessions aux définitions d’outils identiques. Chaque session conserve son modèle.',
    connectionHint:
      'Envoyez x-spillway-session avec un nouvel ID aléatoire dès la première requête, puis réutilisez-le à chaque tour. Appels de fonctions Chat, Responses et Messages avec streaming, jusqu’à 24 heures.',
    nativeContextHint:
      'Les fournisseurs natifs prennent en charge Responses avec store: true et previous_response_id, ainsi que les blocs thinking et signatures Messages inchangés. Après un tour natif interrompu, commencez une nouvelle conversation.',
    fallbackHint:
      'Une erreur du fournisseur arrête la requête. Un autre modèle nécessite une nouvelle conversation.',
    newEvidence:
      'Comparez une boucle d’outils complète avant le routage : les deux modèles doivent réussir avec des coûts connus.',
    profileHint:
      'Les boucles complètes peuvent créer un profil de session. La vérification d’un seul appel n’active pas le routage.',
    tracePinned: 'Session conservée sur {model}',
    traceBlocked: 'Requête de session bloquée',
    traceKept: 'La session a conservé son modèle malgré une règle',
  },
  es: {
    toolsMode: 'Sesiones con herramientas',
    textMode: 'Solicitudes de texto',
    rollout: 'Sesiones nuevas con el candidato',
    rolloutHint:
      'La proporción solo afecta a sesiones nuevas. 0% detiene asignaciones nuevas; las sesiones existentes conservan su modelo.',
    activeSessions: 'Sesiones con herramientas activas',
    applyHint:
      'Usa el modelo probado para nuevas sesiones con definiciones de herramientas coincidentes. Cada sesión conserva su modelo.',
    connectionHint:
      'Envía x-spillway-session con un ID aleatorio nuevo desde la primera solicitud y reutilízalo en cada turno. Admite funciones Chat, Responses y Messages con streaming durante un máximo de 24 horas.',
    nativeContextHint:
      'Los proveedores nativos admiten Responses con store: true y previous_response_id, y bloques thinking y firmas de Messages sin cambios. Tras un turno nativo interrumpido, inicia una conversación nueva.',
    fallbackHint:
      'Los errores del proveedor detienen la solicitud. Otro modelo requiere una conversación nueva.',
    newEvidence:
      'Compara un ciclo completo antes de activar el enrutamiento: ambos modelos deben aprobar con costes conocidos.',
    profileHint:
      'Los ciclos completos pueden crear un perfil de sesión. La comprobación de una llamada no activa el enrutamiento.',
    tracePinned: 'La sesión sigue con {model}',
    traceBlocked: 'Solicitud de sesión bloqueada',
    traceKept: 'La sesión conservó su modelo pese a una regla',
  },
  zh: {
    toolsMode: '工具会话',
    textMode: '文本请求',
    rollout: '使用候选模型的新会话比例',
    rolloutHint: '比例变更仅影响新会话。0%停止新的候选分配；现有会话保持其模型。',
    activeSessions: '活跃工具会话',
    applyHint: '将测试过的模型用于工具定义匹配的新会话。每个会话保持同一模型。',
    connectionHint:
      '从首次请求起发送带随机新 ID 的 x-spillway-session，并在每轮重复使用。支持流式 Chat、Responses 和 Messages 函数调用，有效期最长24小时。',
    nativeContextHint:
      '原生供应商还支持通过 store: true 和 previous_response_id 继续 Responses，以及原样保留 Messages 的 thinking 块和签名。原生轮次中断后，请开始新对话。',
    fallbackHint: '供应商出错会停止请求。使用其他模型需要新建对话。',
    newEvidence: '启用工具路由前，请对比完整工具循环：两个模型必须通过检查且费用已知。',
    profileHint: '完整工具循环可以创建会话路由配置。单次调用检查不能启用路由。',
    tracePinned: '会话保持使用 {model}',
    traceBlocked: '会话请求已阻止',
    traceKept: '触发路由规则后会话仍保持原模型',
  },
};
