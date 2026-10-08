const en = {
  title: 'Saved task sets',
  load: 'Load a task set',
  save: 'Save as new set',
  update: 'Save new revision',
  detach: 'Use unsaved tasks',
  remove: 'Delete set',
  confirmDelete: 'Delete this task set? Existing reports and reference snapshots will remain.',
  hint: 'Save the current tasks, system instructions and output cap for repeatable checks. The comparison name becomes the set name. Keys, models and budgets are chosen for each run.',
  privacy:
    'Saved templates follow text storage and retention settings. Replace personal data and secrets with synthetic placeholders before saving.',
  storageOff:
    'Text storage is disabled. Enable it in Settings to save or load sets; disabling it deletes saved templates.',
  changed:
    'Tasks differ from the saved revision. Save a new revision or reload before comparing against a reference.',
  revision: 'Revision',
  expires: 'Expires',
  reference: 'Reference run',
  noReference: 'No reference selected yet',
  pin: 'Use this run as reference',
  pinHint:
    'Finish every check and manual review, then select a reference. Future runs of the same tasks compare against its frozen results.',
  repeat: 'Load the current task set revision',
  regressions: 'Changes against the reference',
  compared: 'Compared tasks',
  regressed: 'Previously passed, now failed',
  improved: 'Previously failed, now passed',
  inconclusive: 'Not comparable / needs review',
  operational: 'Execution errors',
  newModel: 'This model was absent from the reference.',
  configurationChanged:
    'Model or provider configuration changed; prices can also affect cost differences.',
  pairedCost: 'Cost on matching evaluated tasks',
  pairedLatency: 'Mean time on matching evaluated tasks',
  metricHint:
    'Previous → current; metrics use the shown matching task count. This is one observation, not a statistical guarantee or a reason to change routing automatically.',
  storageError: 'Enable text storage to save or load task sets',
  safeError: 'Use synthetic placeholders instead of personal data or secrets in saved tasks',
  staleError: 'Task set changed; load the latest revision',
  dirtyError: 'Tasks changed; save or load a task set revision before running',
  missingError: 'Task set not found or expired',
  referenceError: 'Finish every automatic check and manual review before setting a reference',
  mismatchError: 'Reference must use the same saved tasks and output limit',
};
type Messages = typeof en;
const ru: Messages = {
  title: 'Сохранённые наборы задач',
  load: 'Загрузить набор задач',
  save: 'Сохранить новый набор',
  update: 'Сохранить новую версию',
  detach: 'Использовать несохранённые задачи',
  remove: 'Удалить набор',
  confirmDelete: 'Удалить набор задач? Отчёты и снимки эталонных результатов сохранятся.',
  hint: 'Сохраните задачи, системные инструкции и предел выходных токенов для повторных проверок. Название сравнения станет названием набора. Ключ, модели и бюджет выбираются для каждого прогона.',
  privacy:
    'Шаблоны учитывают настройку хранения текстов и срок хранения. Перед сохранением замените персональные данные и секреты вымышленными значениями.',
  storageOff:
    'Хранение текстов отключено. Включите его в настройках для сохранения и загрузки наборов. Отключение удаляет сохранённые шаблоны.',
  changed:
    'Задачи отличаются от сохранённой версии. Сохраните новую версию или загрузите исходную для сравнения с эталоном.',
  revision: 'Версия',
  expires: 'Срок хранения',
  reference: 'Эталонный прогон',
  noReference: 'Эталон ещё не выбран',
  pin: 'Сделать этот прогон эталоном',
  pinHint:
    'Завершите все проверки и ручную оценку, затем выберите эталон. Следующие прогоны тех же задач сравнятся с зафиксированными результатами.',
  repeat: 'Загрузить текущую версию набора',
  regressions: 'Изменения относительно эталона',
  compared: 'Сопоставленные задачи',
  regressed: 'Ранее пройдены, теперь провалены',
  improved: 'Ранее провалены, теперь пройдены',
  inconclusive: 'Нельзя сопоставить / нужна оценка',
  operational: 'Ошибки выполнения',
  newModel: 'Этой модели не было в эталонном прогоне.',
  configurationChanged:
    'Настройки модели или провайдера изменились; цены также могут влиять на разницу расходов.',
  pairedCost: 'Стоимость сопоставленных проверенных задач',
  pairedLatency: 'Среднее время сопоставленных проверенных задач',
  metricHint:
    'Раньше → сейчас; метрики рассчитаны по указанному числу совпадающих задач. Один прогон не даёт статистической гарантии и не меняет маршрутизацию автоматически.',
  storageError: 'Включите хранение текстов для сохранения или загрузки наборов задач.',
  safeError: 'Замените персональные данные и секреты в шаблонах вымышленными значениями.',
  staleError: 'Набор изменился. Загрузите последнюю версию.',
  dirtyError: 'Задачи изменились. Сохраните или загрузите версию набора перед запуском.',
  missingError: 'Набор задач не найден или срок хранения истёк.',
  referenceError: 'Завершите все автоматические проверки и ручную оценку перед выбором эталона.',
  mismatchError: 'Эталон должен использовать те же сохранённые задачи и предел токенов.',
};
const de: Messages = {
  title: 'Gespeicherte Aufgabensätze',
  load: 'Aufgabensatz laden',
  save: 'Als neuen Satz speichern',
  update: 'Neue Version speichern',
  detach: 'Ungespeicherte Aufgaben verwenden',
  remove: 'Satz löschen',
  confirmDelete: 'Aufgabensatz löschen? Berichte und Referenzergebnisse bleiben erhalten.',
  hint: 'Aufgaben, Systemanweisungen und Ausgabelimit für wiederholbare Prüfungen speichern. Der Vergleichsname wird zum Satznamen. Schlüssel, Modelle und Budget werden pro Lauf gewählt.',
  privacy:
    'Vorlagen folgen Textspeicherung und Aufbewahrungsfrist. Personenbezogene Daten und Geheimnisse vor dem Speichern durch synthetische Platzhalter ersetzen.',
  storageOff:
    'Textspeicherung ist deaktiviert. Zum Speichern und Laden in den Einstellungen aktivieren. Deaktivieren löscht gespeicherte Vorlagen.',
  changed:
    'Aufgaben weichen von der gespeicherten Version ab. Neue Version speichern oder die ursprüngliche für den Referenzvergleich laden.',
  revision: 'Version',
  expires: 'Ablauf',
  reference: 'Referenzlauf',
  noReference: 'Noch keine Referenz gewählt',
  pin: 'Diesen Lauf als Referenz verwenden',
  pinHint:
    'Alle Prüfungen und manuellen Bewertungen abschließen und eine Referenz wählen. Zukünftige Läufe vergleichen dieselben Aufgaben mit den eingefrorenen Ergebnissen.',
  repeat: 'Aktuelle Aufgabensatzversion laden',
  regressions: 'Änderungen gegenüber der Referenz',
  compared: 'Verglichene Aufgaben',
  regressed: 'Zuvor bestanden, jetzt fehlgeschlagen',
  improved: 'Zuvor fehlgeschlagen, jetzt bestanden',
  inconclusive: 'Nicht vergleichbar / Bewertung nötig',
  operational: 'Ausführungsfehler',
  newModel: 'Dieses Modell war nicht in der Referenz.',
  configurationChanged:
    'Modell- oder Anbieterkonfiguration geändert; Preise können Kostenunterschiede beeinflussen.',
  pairedCost: 'Kosten übereinstimmender bewerteter Aufgaben',
  pairedLatency: 'Mittlere Zeit übereinstimmender bewerteter Aufgaben',
  metricHint:
    'Vorher → jetzt; Metriken verwenden die angezeigte Zahl passender Aufgaben. Ein Lauf ist keine statistische Garantie und ändert das Routing nicht automatisch.',
  storageError: 'Textspeicherung zum Speichern oder Laden von Aufgabensätzen aktivieren.',
  safeError: 'Personenbezogene Daten und Geheimnisse durch synthetische Platzhalter ersetzen.',
  staleError: 'Aufgabensatz geändert; aktuelle Version laden.',
  dirtyError: 'Aufgaben geändert; vor dem Start eine Satzversion speichern oder laden.',
  missingError: 'Aufgabensatz nicht gefunden oder abgelaufen.',
  referenceError: 'Alle Prüfungen und manuellen Bewertungen vor der Referenzwahl abschließen.',
  mismatchError:
    'Referenz muss dieselben gespeicherten Aufgaben und das gleiche Ausgabelimit verwenden.',
};
const fr: Messages = {
  title: 'Jeux de tâches enregistrés',
  load: 'Charger un jeu',
  save: 'Enregistrer un nouveau jeu',
  update: 'Enregistrer une nouvelle version',
  detach: 'Utiliser des tâches non enregistrées',
  remove: 'Supprimer le jeu',
  confirmDelete: 'Supprimer ce jeu ? Les rapports et résultats de référence seront conservés.',
  hint: 'Enregistrez tâches, instructions système et limite de sortie pour répéter les tests. Le nom de la comparaison devient celui du jeu. Clé, modèles et budget sont choisis à chaque exécution.',
  privacy:
    'Les modèles de tâches suivent le stockage des textes et la rétention. Remplacez données personnelles et secrets par des valeurs fictives.',
  storageOff:
    'Le stockage des textes est désactivé. Activez-le dans les paramètres pour enregistrer ou charger des jeux. Le désactiver supprime les modèles enregistrés.',
  changed:
    'Les tâches diffèrent de la version enregistrée. Enregistrez une nouvelle version ou rechargez la version initiale pour comparer à la référence.',
  revision: 'Version',
  expires: 'Expiration',
  reference: 'Exécution de référence',
  noReference: 'Aucune référence sélectionnée',
  pin: 'Utiliser cette exécution comme référence',
  pinHint:
    'Terminez tous les contrôles et évaluations manuelles, puis choisissez une référence. Les prochaines exécutions compareront les mêmes tâches aux résultats figés.',
  repeat: 'Charger la version actuelle du jeu',
  regressions: 'Évolution par rapport à la référence',
  compared: 'Tâches comparées',
  regressed: 'Réussies auparavant, échouées maintenant',
  improved: 'Échouées auparavant, réussies maintenant',
  inconclusive: 'Non comparables / à évaluer',
  operational: 'Erreurs d’exécution',
  newModel: 'Ce modèle était absent de la référence.',
  configurationChanged:
    'Configuration du modèle ou du fournisseur modifiée ; les prix peuvent modifier les écarts de coût.',
  pairedCost: 'Coût des tâches évaluées correspondantes',
  pairedLatency: 'Temps moyen des tâches évaluées correspondantes',
  metricHint:
    'Avant → maintenant ; les mesures utilisent le nombre de tâches correspondantes indiqué. Une exécution ne garantit pas la qualité et ne modifie pas automatiquement le routage.',
  storageError: 'Activez le stockage des textes pour enregistrer ou charger des jeux.',
  safeError: 'Remplacez données personnelles et secrets par des valeurs fictives.',
  staleError: 'Jeu modifié ; chargez la dernière version.',
  dirtyError: 'Tâches modifiées ; enregistrez ou chargez une version avant de démarrer.',
  missingError: 'Jeu introuvable ou expiré.',
  referenceError:
    'Terminez tous les contrôles et évaluations manuelles avant de choisir la référence.',
  mismatchError:
    'La référence doit utiliser les mêmes tâches enregistrées et la même limite de sortie.',
};
const es: Messages = {
  title: 'Conjuntos de tareas guardados',
  load: 'Cargar un conjunto',
  save: 'Guardar nuevo conjunto',
  update: 'Guardar nueva versión',
  detach: 'Usar tareas sin guardar',
  remove: 'Eliminar conjunto',
  confirmDelete: '¿Eliminar este conjunto? Se conservarán los informes y resultados de referencia.',
  hint: 'Guarda tareas, instrucciones y límite de salida para repetir las pruebas. El nombre de la comparación será el del conjunto. La clave, modelos y presupuesto se eligen en cada ejecución.',
  privacy:
    'Las plantillas respetan el almacenamiento de textos y su retención. Sustituye datos personales y secretos por valores ficticios antes de guardar.',
  storageOff:
    'El almacenamiento de textos está desactivado. Actívalo en Ajustes para guardar o cargar conjuntos. Desactivarlo elimina las plantillas guardadas.',
  changed:
    'Las tareas difieren de la versión guardada. Guarda una nueva versión o carga la original para comparar con la referencia.',
  revision: 'Versión',
  expires: 'Caducidad',
  reference: 'Ejecución de referencia',
  noReference: 'Aún no hay referencia',
  pin: 'Usar esta ejecución como referencia',
  pinHint:
    'Completa todas las comprobaciones y revisiones manuales y elige una referencia. Las siguientes ejecuciones compararán las mismas tareas con sus resultados guardados.',
  repeat: 'Cargar la versión actual del conjunto',
  regressions: 'Cambios respecto a la referencia',
  compared: 'Tareas comparadas',
  regressed: 'Antes aprobadas, ahora fallidas',
  improved: 'Antes fallidas, ahora aprobadas',
  inconclusive: 'No comparables / pendientes de revisión',
  operational: 'Errores de ejecución',
  newModel: 'Este modelo no estaba en la referencia.',
  configurationChanged:
    'Cambió la configuración del modelo o proveedor; los precios también pueden afectar la diferencia de costes.',
  pairedCost: 'Coste de tareas evaluadas coincidentes',
  pairedLatency: 'Tiempo medio de tareas evaluadas coincidentes',
  metricHint:
    'Antes → ahora; las métricas usan la cantidad indicada de tareas coincidentes. Una ejecución no es una garantía estadística ni cambia el enrutamiento automáticamente.',
  storageError: 'Activa el almacenamiento de textos para guardar o cargar conjuntos.',
  safeError: 'Sustituye datos personales y secretos por valores ficticios.',
  staleError: 'El conjunto cambió; carga la última versión.',
  dirtyError: 'Las tareas cambiaron; guarda o carga una versión antes de iniciar.',
  missingError: 'Conjunto no encontrado o caducado.',
  referenceError:
    'Completa todas las comprobaciones y revisiones manuales antes de elegir la referencia.',
  mismatchError: 'La referencia debe usar las mismas tareas guardadas y el mismo límite de salida.',
};
const zh: Messages = {
  title: '已保存的任务集',
  load: '加载任务集',
  save: '保存为新任务集',
  update: '保存新版本',
  detach: '使用未保存的任务',
  remove: '删除任务集',
  confirmDelete: '删除此任务集？现有报告和参考结果快照将保留。',
  hint: '保存任务、系统指令和输出上限，以便重复检查。比较名称将作为任务集名称。每次运行分别选择密钥、模型和预算。',
  privacy: '模板遵循文本存储和保留期限设置。保存前请用虚构占位符替换个人数据和密钥等敏感信息。',
  storageOff: '文本存储已关闭。请在设置中启用后保存或加载任务集；关闭会删除已保存的模板。',
  changed: '任务与已保存版本不同。请保存新版本或重新加载原版本后再与参考比较。',
  revision: '版本',
  expires: '到期时间',
  reference: '参考运行',
  noReference: '尚未选择参考',
  pin: '将本次运行设为参考',
  pinHint: '完成所有检查和人工评估后选择参考。后续相同任务的运行将与固定的参考结果比较。',
  repeat: '加载任务集的当前版本',
  regressions: '相对于参考的变化',
  compared: '已比较任务',
  regressed: '以前通过、现在失败',
  improved: '以前失败、现在通过',
  inconclusive: '无法比较 / 需要评估',
  operational: '执行错误',
  newModel: '参考中没有此模型。',
  configurationChanged: '模型或提供商配置已更改；价格变化也会影响成本差异。',
  pairedCost: '相同已评估任务的成本',
  pairedLatency: '相同已评估任务的平均时间',
  metricHint: '之前 → 现在；指标使用显示的匹配任务数。单次运行不是统计保证，也不会自动更改路由。',
  storageError: '请启用文本存储后保存或加载任务集。',
  safeError: '请用虚构占位符替换任务中的个人数据和敏感信息。',
  staleError: '任务集已更改；请加载最新版本。',
  dirtyError: '任务已更改；请在运行前保存或加载任务集版本。',
  missingError: '任务集不存在或已到期。',
  referenceError: '设置参考前请完成所有自动检查和人工评估。',
  mismatchError: '参考必须使用相同的已保存任务和输出上限。',
};
export const evaluationMessages = { en, ru, de, fr, es, zh };

export function evaluationError(error: unknown, t: Messages): unknown {
  if (!(error instanceof Error)) return error;
  const keys = [
    'storageError',
    'safeError',
    'staleError',
    'dirtyError',
    'missingError',
    'referenceError',
    'mismatchError',
  ] as const;
  const key = keys.find((item) => en[item] === error.message);
  return key ? new Error(t[key]) : error;
}
