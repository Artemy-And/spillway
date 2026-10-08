import { fmtLimit, fmtNumber, fmtUsd } from '../lib/format.ts';
import { comparisonMessages } from './comparisons.ts';
import type { Messages } from './en.ts';
import { evaluationMessages } from './evaluations.ts';
import { describePii, plural, type TraceParams } from './helpers.ts';
import { profileErrors, profileMessages, profileTrace } from './profiles.ts';
import { budgetMessages, budgetTrace } from './reservations.ts';
import { sessionRoutingMessages } from './session-routing.ts';
import { toolEvaluationMessages } from './tool-evaluations.ts';

const p = plural('de');

const pii = {
  secret: 'API-Schlüssel',
  email: 'E-Mail-Adressen',
  card: 'Kartennummern',
  iban: 'IBANs',
  ssn: 'SSNs',
  nino: 'britische NI-Nummern',
  snils: 'SNILS-Nummern',
  passport: 'Passnummern',
  inn: 'INN-Nummern',
  phone: 'Telefonnummern',
  ip: 'IP-Adressen',
};

const times = (n: number) => p(n, { one: 'einmal', other: '#-mal' });

export const de: Messages = {
  comparisons: comparisonMessages.de,
  evaluations: evaluationMessages.de,
  toolEvaluations: toolEvaluationMessages.de,
  sessionRouting: sessionRoutingMessages.de,
  reservations: budgetMessages.de,
  profiles: profileMessages.de,
  common: {
    save: 'Speichern',
    saved: 'Gespeichert',
    cancel: 'Abbrechen',
    close: 'Schließen',
    copy: 'Kopieren',
    copied: 'Kopiert',
    on: 'An',
    off: 'Aus',
    none: 'keins',
    local: 'lokal',
    noTeam: 'Kein Team',
    team: 'Team',
    name: 'Name',
    email: 'E-Mail',
    password: 'Passwort',
    language: 'Sprache',
    model: 'Modell',
    key: 'Schlüssel',
    type: 'Typ',
    status: 'Status',
    role: 'Rolle',
    member: 'Mitglied',
    admin: 'Admin',
    period: 'Zeitraum',
    edit: (name) => `${name} bearbeiten`,
    delete: (name) => `${name} löschen`,
  },
  kinds: { person: 'Person', device: 'Gerät', agent: 'Agent' },
  results: {
    ok: 'OK',
    rerouted: 'Umgeleitet',
    blocked_pii: 'Blockiert · Daten',
    blocked_budget: 'Blockiert · Budget',
    blocked_model: 'Blockiert · Modell',
    rate_limited: 'Ratenlimit',
    error: 'Fehler',
  },
  pii,
  masked: {
    label: (kind) => `[${kind} verborgen]`,
    kinds: {
      secret: 'Schlüssel',
      email: 'E-Mail',
      card: 'Karte',
      iban: 'IBAN',
      ssn: 'SSN',
      nino: 'NI-Nummer',
      snils: 'SNILS',
      passport: 'Pass',
      inn: 'INN',
      phone: 'Telefon',
      ip: 'IP',
    },
  },

  errors: {
    ...profileErrors.de,
    'Wrong setup code. Spillway prints the setup link in its logs.':
      'Falscher Einrichtungscode. Spillway schreibt den Einrichtungslink beim Start ins Log.',
    'Your email comes from single sign-on and cannot be changed here':
      'Ihre E-Mail-Adresse kommt aus dem Single Sign-on und lässt sich hier nicht ändern',
    'This is a read-only demo with made-up data. Install Spillway to try changes.':
      'Dies ist eine schreibgeschützte Demo mit erfundenen Daten. Installieren Sie Spillway, um Änderungen auszuprobieren.',
    'A team with this name already exists': 'Ein Team mit diesem Namen gibt es bereits',
    'This invite link is invalid or has expired':
      'Dieser Einladungslink ist ungültig oder abgelaufen',
    'Person not found': 'Person nicht gefunden',
    'Wrong email or password': 'E-Mail oder Passwort falsch',
    'Too many attempts. Try again in 15 minutes.':
      'Zu viele Versuche. Versuchen Sie es in 15 Minuten erneut.',
    'Sign in to continue': 'Bitte melden Sie sich an',
    'Only admins can do this': 'Das dürfen nur Admins',
    'Spillway is already set up. Sign in instead.':
      'Spillway ist bereits eingerichtet. Bitte melden Sie sich an.',
    'Use at least 8 characters': 'Mindestens 8 Zeichen',
    'Someone already uses this email': 'Diese E-Mail wird bereits verwendet',
    'The current password is wrong': 'Das aktuelle Passwort ist falsch',
    'This person is already added': 'Diese Person ist bereits hinzugefügt',
    'You cannot demote or disable yourself':
      'Sie können sich nicht selbst herabstufen oder deaktivieren',
    'Provider not found': 'Anbieter nicht gefunden',
    'A model with this name already exists': 'Ein Modell mit diesem Namen gibt es bereits',
    'Request not found': 'Anfrage nicht gefunden',
    'Internal error': 'Interner Fehler',
    'SSO is not configured': 'SSO ist nicht eingerichtet',
    'Could not reach the identity provider': 'Der Identitätsanbieter ist nicht erreichbar',
    'Sign-in expired, try again': 'Anmeldung abgelaufen, bitte erneut versuchen',
    'This account is disabled': 'Dieses Konto ist deaktiviert',
  },

  nav: {
    routingProfiles: profileMessages.de.title,
    comparisons: 'Modelle vergleichen',
    main: 'Hauptmenü',
    overview: 'Übersicht',
    keys: 'Schlüssel',
    budgets: 'Budgets & Regeln',
    logs: 'Anfrageprotokoll',
    models: 'Modelle & Anbieter',
    settings: 'Einstellungen & SSO',
    account: 'Konto',
    openMenu: 'Menü öffnen',
    closeMenu: 'Menü schließen',
    signOut: 'Abmelden',
    healthy: 'Gateway läuft',
    source: 'Quellcode',
    degraded: (providers) => `Störung: ${providers}`,
    degradedHint:
      'Die letzte Anfrage an diesen Anbieter in den letzten 10 Minuten ist fehlgeschlagen. Wo möglich, antwortet stattdessen das lokale Modell.',
    offline: 'Keine Verbindung zum Gateway',
    offlineBanner:
      'Keine Verbindung zum Gateway. Die Zahlen auf dieser Seite sind womöglich veraltet; neuer Versuch alle 15 Sekunden.',
    demoBanner:
      'Schreibgeschützte Demo: eine erfundene Firma mit generiertem Verkehr. Alles, was etwas ändern würde, ist abgeschaltet.',
    demoInstall: 'Spillway installieren →',
    providers: (all, local) =>
      `${p(all, { one: '# Anbieter', other: '# Anbieter' })} · ${local} lokal`,
    selfHosted: (version) => `v${version} · selbst gehostet`,
  },

  login: {
    title: 'Anmelden',
    subtitle: 'Schlüssel, Budgets und das Anfrageprotokoll verwalten.',
    orPassword: 'oder mit Passwort',
    submit: 'Anmelden',
    submitting: 'Anmeldung…',
  },

  setup: {
    code: 'Einrichtungscode',
    codeHint: 'Spillway schreibt beim Start einen Link damit ins Log: docker logs spillway',
    title: 'Willkommen bei Spillway',
    subtitle:
      'Legen Sie das Admin-Konto an. Damit melden Sie sich an, verbinden KI-Anbieter und vergeben Schlüssel.',
    name: 'Ihr Name',
    passwordHint: 'Mindestens 8 Zeichen.',
    confirm: 'Passwort wiederholen',
    mismatch: 'Die Passwörter stimmen nicht überein',
    submit: 'Konto anlegen',
    submitting: 'Wird angelegt…',
    note: 'Diese Seite erscheint nur, solange es noch kein Konto gibt.',
    orSso: 'oder mit Passwort',
    ssoHint: 'Bei Single Sign-on wird die erste Person aus einer erlaubten Domain Admin.',
  },

  invite: {
    title: 'Spillway beitreten',
    subtitle: (email) =>
      `Sie wurden als ${email} eingeladen. Wählen Sie Ihren Namen und ein Passwort.`,
    resetTitle: 'Neues Passwort festlegen',
    resetSubtitle: (email) =>
      `Für ${email}. Mit dem alten Passwort angemeldete Browser werden abgemeldet.`,
    submit: 'Beitreten',
    resetSubmit: 'Passwort speichern',
    submitting: 'Wird gespeichert…',
    checking: 'Link wird geprüft…',
    toSignIn: 'Zur Anmeldung',
  },

  welcome: {
    label: 'Einführung',
    skip: 'Überspringen',
    next: 'Weiter',
    back: 'Zurück',
    start: 'Einrichtung starten',
    finish: 'Verstanden',
    step: (current, total) => `${current} von ${total}`,
    slides: [
      {
        title: 'Ein Gateway für alle KI-Modelle',
        text: 'Personen, Geräte und Agenten bekommen eigene Spillway-Schlüssel, statt Anbieter-Schlüssel zu teilen. Jede Anfrage läuft hier durch, also sehen Sie, wer was genutzt hat und was es gekostet hat.',
      },
      {
        title: 'Limits, die die Arbeit nicht stoppen',
        text: 'Schlüssel und Teams haben Tages- oder Monatsbudgets. Ist eines aufgebraucht oder fällt ein Cloud-Anbieter aus, wechseln Anfragen still auf ein lokales Modell, statt zu scheitern.',
      },
      {
        title: 'Private Daten bleiben im Haus',
        text: 'Kartennummern, Pässe und API-Schlüssel erreichen nie ein Cloud-Modell, persönliche Daten werden im Protokoll maskiert. Lokale Modelle sehen sie weiterhin.',
      },
      {
        title: 'Fünf Schritte zur ersten Anfrage',
        text: 'Eine Checkliste auf der Übersicht führt Sie durch: Anbieter verbinden, Modelle hinzufügen, lokales Modell wählen, Schlüssel erstellen und eine Anfrage senden.',
      },
    ],
    memberSlides: [
      {
        title: 'Ihr Schlüssel zu allen KI-Modellen',
        text: 'Erstellen Sie für jede App und jedes Gerät einen Spillway-Schlüssel. Welche Modelle er nutzen darf und wie viel er ausgeben darf, legt Ihr Admin fest.',
      },
      {
        title: 'Sehen, was Sie senden',
        text: 'Das Anfrageprotokoll zeigt jede Anfrage, das antwortende Modell und die Kosten. Persönliche Daten werden vor dem Speichern maskiert.',
      },
    ],
  },

  checklist: {
    title: 'Erste Schritte',
    progress: (done, total) => `${done} von ${total} erledigt`,
    hide: 'Ausblenden',
    allDone: 'Alles bereit. Spillway kann an Ihr Team gehen.',
    steps: {
      provider: {
        title: 'Anbieter verbinden',
        text: 'Eine Cloud-API mit Schlüssel (OpenAI, Anthropic, OpenRouter…) oder Ollama für lokale Modelle.',
        action: 'Anbieter hinzufügen',
      },
      models: {
        title: 'Modelle hinzufügen',
        text: 'Wählen Sie die Modelle, die genutzt werden dürfen, und tragen Sie Preise ein, um Kosten zu verfolgen.',
        action: 'Modelle hinzufügen',
      },
      local: {
        title: 'Lokales Modell wählen',
        text: 'Hierhin gehen Anfragen, wenn ein Budget aufgebraucht oder die Cloud ausgefallen ist. Optional, hält aber die Arbeit am Laufen.',
        action: 'Einstellungen öffnen',
      },
      key: {
        title: 'Schlüssel erstellen',
        text: 'Einen pro Person, Gerät oder Agent. Limits und Modellzugriff gelten pro Schlüssel.',
        action: 'Schlüssel erstellen',
      },
      request: {
        title: 'Erste Anfrage senden',
        text: 'Den Schlüssel in eine Chat-App, eine IDE oder curl eintragen. Die Anfrage erscheint nach Sekunden im Protokoll.',
        action: 'Protokoll öffnen',
      },
    },
  },

  account: {
    title: 'Konto',
    subtitle: 'Name, E-Mail, Passwort und Sprache.',
    profile: 'Profil',
    emailFromSso: 'Ihre E-Mail-Adresse kommt aus dem Single Sign-on.',
    password: 'Passwort',
    current: 'Aktuelles Passwort',
    newPassword: 'Neues Passwort',
    confirm: 'Neues Passwort wiederholen',
    change: 'Passwort ändern',
    changed: 'Passwort geändert. Andere Browser müssen sich neu anmelden.',
    noPassword:
      'Sie melden sich per SSO an. Legen Sie ein Passwort fest, um sich auch per E-Mail anzumelden.',
    languageHint: 'Wird in diesem Browser gespeichert.',
    tour: 'Erste Schritte',
    tourText: 'Einführung und Checkliste auf der Übersicht erneut anzeigen.',
    tourButton: 'Erneut anzeigen',
  },

  chart: { cloud: 'Cloud', local: 'Lokal', day: 'Tag' },

  overview: {
    title: 'Übersicht',
    periods: { '7d': '7 Tage', '30d': '30 Tage', month: 'Dieser Monat' },
    lastDays: (days) => `Letzte ${days} Tage`,
    allTeams: 'alle Teams',
    yourKeys: 'Ihre Schlüssel',
    activeKeys: (n) => p(n, { one: '# aktiver Schlüssel', other: '# aktive Schlüssel' }),
    exportCsv: 'CSV exportieren',
    keyNumbers: 'Kennzahlen',
    spendThisMonth: 'Ausgaben diesen Monat',
    spendPeriod: (period) => `Ausgaben · ${period}`,
    budgetUsed: 'Budget verbraucht',
    budgetLine: (percent, budget, date) =>
      `${percent}% von ${budget} Budget · zurückgesetzt am ${date}`,
    budgetsMonthly: 'Team-Budgets gelten pro Monat',
    noBudgets: 'Noch keine Team-Budgets',
    saved: (amount) => `${amount} durch lokale Modelle gespart`,
    savedCache: (amount) => `${amount} durch den Cache gespart`,
    requests: 'Anfragen',
    vsPrevious: (change) => `${change}% ggü. Vorperiode`,
    from: (parts) => `von ${parts}`,
    people: (n) => p(n, { one: '# Person', other: '# Personen' }),
    sharedKeys: (n) => p(n, { one: '# geteiltem Schlüssel', other: '# geteilten Schlüsseln' }),
    devices: (n) => p(n, { one: '# Gerät', other: '# Geräten' }),
    agents: (n) => p(n, { one: '# Agent', other: '# Agenten' }),
    noTraffic: 'Noch kein Verkehr',
    servedLocal: 'Von lokalen Modellen beantwortet',
    shareLocal: 'Anteil lokal beantwortet',
    localRequests: (n) =>
      p(n, { one: '# Anfrage ohne API-Kosten', other: '# Anfragen ohne API-Kosten' }),
    blocked: 'Blockierte Anfragen',
    blockedPii: (n) => `${n} mit sensiblen Daten`,
    blockedOther: (n) => `${n} wegen Budget, Ratenlimit oder Modellzugriff`,
    perDay: 'Anfragen pro Tag · letzte 14 Tage',
    perDayLabel: 'Anfragen pro Tag',
    cloudPaid: 'Cloud (kostenpflichtig)',
    localFree: 'Lokal (kostenlos)',
    attention: 'Braucht Aufmerksamkeit',
    viewLog: 'Zum Protokoll',
    nothing:
      'Alles ruhig. Limits, Sperren, ausfallende Anbieter und ungenutzte Schlüssel erscheinen hier.',
    topSpenders: 'Größte Verbraucher',
    requestsCol: 'Anfragen',
    spend: 'Ausgaben',
    share: 'Anteil an Ausgaben',
    shareOf: (name) => `Ausgabenanteil von ${name}`,
    noRequests: 'In diesem Zeitraum noch keine Anfragen.',
    byModel: 'Ausgaben nach Modell',
    modelSpend: (name) => `Ausgaben für ${name}`,
    noPaid: 'Keine kostenpflichtigen Anfragen in diesem Zeitraum.',
    localReq: (n) => `${n} Anfr. · 0 $`,
  },

  alerts: {
    keyLimit: (a) => `${a.key} hat ${a.percent}% des Tageslimits von ${fmtLimit(a.limit)} erreicht`,
    keyUnused: (a) =>
      `Schlüssel ${a.key} wurde seit ${p(a.days, { one: '# Tag', other: '# Tagen' })} nicht genutzt`,
    considerRevoking: 'Eventuell widerrufen',
    modelNoPrice: (a) =>
      `Cloud-Modelle ohne Preis: ${a.models.length}. Ihre Kosten fließen nicht in die Budgets ein`,
    piiBlocked: (a) =>
      `${p(a.count, { one: '# Anfrage', other: '# Anfragen' })} an Cloud-Modelle blockiert: sensible Daten gefunden`,
    teamOverBudget: (a) =>
      `${a.team} hat das Monatsbudget überschritten; Anfragen gehen an lokale Modelle`,
    spentOf: (spent, budget) => `${spent} von ${budget}`,
    promptCut: (a) =>
      `${a.model} hat in den letzten 24 Stunden bei ${p(a.count, { one: '# langen Prompt', other: '# langen Prompts' })} den Anfang verloren: Der Kontext von Ollama ist zu klein`,
    providerFailing: (a) =>
      `${a.provider} ist in den letzten 24 Stunden ${times(a.failed + a.rescued)} ausgefallen` +
      (a.rescued ? `; das lokale Modell hat ${times(a.rescued)} übernommen` : ''),
  },

  keys: {
    title: 'Schlüssel',
    subtitle:
      'Ein Schlüssel pro Person, Gerät oder Agent. Einen widerrufen, ohne die anderen anzufassen.',
    newKey: 'Neuer Schlüssel',
    allKeys: 'Alle Schlüssel',
    keyType: 'Schlüsseltyp',
    filterAll: (n) => `Alle ${n}`,
    filterPeople: (n) => `Personen ${n}`,
    filterDevices: (n) => `Geräte ${n}`,
    filterAgents: (n) => `Agenten ${n}`,
    search: 'Schlüssel suchen',
    searchPlaceholder: 'Schlüssel oder Besitzer',
    todayVsLimit: 'Heute / Tageslimit',
    lastUsed: 'Zuletzt genutzt',
    noMatch: 'Keine passenden Schlüssel.',
    none: 'Noch keine Schlüssel. Erstellen Sie einen pro Person, Gerät oder Agent.',
    teamSuffix: (team) => `Team ${team}`,
    noOwner: 'Kein Besitzer',
    limitUsed: (name) => `Tageslimit von ${name} verbraucht`,
    todayNoLimit: (amount) => `${amount} heute · ohne Limit`,
    status: {
      revoked: 'Widerrufen',
      localOnly: 'Nur lokal',
      limitReached: 'Limit erreicht',
      nearLimit: 'Fast am Limit',
      active: 'Aktiv',
    },
    editKey: 'Schlüssel bearbeiten',
    namePlaceholder: 'anna-macbook',
    owner: 'Besitzer',
    nobody: 'Niemand (Team-Schlüssel)',
    ownersTeam: 'Team des Besitzers',
    allowedModels: 'Erlaubte Modelle',
    everything: 'Alles, was das Team nutzen darf',
    daily: 'Tageslimit, $',
    monthly: 'Monatslimit, $',
    fallback: 'Limit erreicht oder Cloud ausgefallen? Lokales Modell nutzen',
    fallbackTo: (model) => `Anfragen gehen an ${model}, statt zu scheitern.`,
    fallbackNone:
      'Wählen Sie zuerst in den Einstellungen ein lokales Modell; bis dahin werden Anfragen blockiert.',
    adminSets: 'Limits für Ihre Schlüssel legt ein Admin fest.',
    revoke: 'Widerrufen',
    revokeConfirm: (name) => `${name} widerrufen? Apps damit funktionieren sofort nicht mehr.`,
    create: 'Schlüssel erstellen',
    keyCreated: 'Schlüssel erstellt',
    ready: (name) => `Schlüssel für ${name} ist bereit`,
    copyNow:
      'Jetzt kopieren. Spillway speichert nur einen Hash und kann ihn nicht erneut anzeigen.',
    copyKey: 'Schlüssel kopieren',
    connect: 'Client verbinden',
    client: 'Client',
    modelPlaceholder: '<Modellname>',
  },

  budgets: {
    title: 'Budgets & Regeln',
    subtitle:
      'Limits pro Team und Regeln, die das Gateway bei jeder Anfrage von oben nach unten prüft.',
    addTeam: 'Team hinzufügen',
    teamBudgets: 'Team-Budgets',
    teamBudgetsMonth: (month) => `Team-Budgets · ${month}`,
    noTeams:
      'Noch keine Teams. Ein Team hat ein Monatsbudget und legt fest, welche Modelle seine Schlüssel nutzen dürfen.',
    routingRules: 'Routing-Regeln',
    localName: (model) => `${model} · lokal`,
    localUnset: 'das lokale Modell (in den Einstellungen wählen)',
    modelAccess: 'Modellzugriff',
    modelAccessTitle: 'Modellzugriff nach Team',
    narrow: 'Schlüssel können das einschränken, nie erweitern',
    addTeamsModels: 'Fügen Sie Teams und Modelle hinzu, um zu steuern, wer was nutzen darf.',
    teamName: 'Teamname',
    monthlyBudget: 'Monatsbudget, $',
    budgetPlaceholder: 'Budget, $',
    noBudget: (spent, keys) =>
      `Kein Budget · ${spent} ausgegeben · ${p(keys, { one: '# Schlüssel', other: '# Schlüssel' })}`,
    over: 'Budget überschritten · Anfragen gehen an lokale Modelle',
    onTrack: (forecast, date) => `Im Plan · Prognose ${forecast} bis ${date}`,
    closeTo: (forecast, date) => `Knapp am Budget · Prognose ${forecast} bis ${date}`,
    teamMonthlyBudget: (team) => `Monatsbudget von ${team}`,
    changeBudget: 'Budget ändern',
    spentOf: (spent, budget) => `${spent} von ${budget}`,
    budgetUsed: (team) => `Budget von ${team} verbraucht`,
    whenLabel: 'WENN',
    thenLabel: 'DANN',
    budgetBefore: 'Team hat',
    budgetAfter: '% oder mehr seines Monatsbudgets ausgegeben',
    thresholdLabel: 'Budgetschwelle in Prozent',
    sendTo: (local) => `Anfrage an ${local} senden`,
    piiWhen:
      'Anfrage enthält Kartennummern, IBANs, SSNs, Pass- oder Ausweisnummern oder API-Schlüssel',
    piiThen: 'Cloud-Modelle blockieren, lokale erlauben',
    agentWhen: 'Schlüsseltyp ist Agent',
    agentBefore: 'Höchstens',
    agentAfter: 'Anfragen pro Minute',
    rpmLabel: 'Anfragen pro Minute',
    offBefore: 'Uhrzeit liegt außerhalb',
    startLabel: 'Arbeitsbeginn',
    endLabel: 'Arbeitsende',
    offThen: 'Nur lokale Modelle',
    zoneHint: 'Zeitzone des Gateways. Änderbar in den Einstellungen.',
    matched: (n) => `Diesen Monat ${times(n)} ausgelöst`,
    discard: 'Verwerfen',
    saveRules: 'Regeln speichern',
    allowed: 'Erlaubt',
    notAllowed: 'Nicht erlaubt',
    toggle: 'Zugriff umschalten',
  },

  logs: {
    title: 'Anfrageprotokoll',
    subtitle: 'Jede Anfrage: wer sie gesendet hat, wohin sie ging, was sie kostete und warum.',
    live: 'Live',
    export: 'Exportieren',
    allKeys: 'Alle Schlüssel',
    allModels: 'Alle Modelle',
    result: 'Ergebnis',
    allResults: 'Alle Ergebnisse',
    last24h: 'Letzte 24 Stunden',
    last7d: 'Letzte 7 Tage',
    last30d: 'Letzte 30 Tage',
    requests: 'Anfragen',
    time: 'Zeit',
    route: 'Angefragt → beantwortet von',
    tokensInOut: 'Tokens ein / aus',
    cost: 'Kosten',
    empty:
      'Keine passenden Anfragen. Senden Sie eine mit einem Schlüssel von der Seite „Schlüssel“.',
    held: 'zurückgehalten',
    blocked: 'blockiert',
    titles: {
      ok: 'Beantwortet',
      rerouted: 'An ein lokales Modell umgeleitet',
      outage: 'Cloud nicht erreichbar: lokal beantwortet',
      blocked_pii: 'Blockiert: sensible Daten',
      blocked_budget: 'Blockiert: Budget überschritten',
      blocked_model: 'Blockiert: Modell nicht erlaubt',
      rate_limited: 'Zurückgehalten: Ratenlimit',
      error: 'Fehler beim Anbieter',
    },
    details: 'Details der Anfrage',
    askedFor: 'Angefragt',
    servedBy: 'Beantwortet von',
    tokens: 'Tokens',
    tokensValue: (input, output) => `${input} ein · ${output} aus`,
    savedAmount: (amount) => `(${amount} gespart)`,
    latency: 'Antwortzeit',
    client: 'Client',
    clientApi: (name) => `${name}-API`,
    streaming: 'Streaming',
    why: 'Warum',
    prompt: 'Anfrage',
    notStored: 'Nicht gespeichert.',
    response: 'Antwort',
    retention: (days) =>
      `Anfragen werden mit maskierten persönlichen Daten ${p(days, { one: '# Tag', other: '# Tage' })} gespeichert. Änderbar in den Einstellungen.`,
  },

  trace: {
    budgetReconciled: (t: TraceParams) => budgetTrace(budgetMessages.de.traceReconciled, t),
    budgetReserved: (t: TraceParams) => budgetTrace(budgetMessages.de.traceReserved, t),
    budgetReservationDenied: () => budgetMessages.de.traceDenied,
    budgetEstimateUnknown: () => budgetMessages.de.traceUnknown,
    budgetUncertain: (t: TraceParams) => budgetTrace(budgetMessages.de.traceUnknownCharge, t),
    profileApplied: (t: TraceParams) => profileTrace(profileMessages.de, 'traceApplied', t),
    profileSkipped: (t: TraceParams) => profileTrace(profileMessages.de, 'traceSkipped', t),
    profileFallback: (t: TraceParams) => profileTrace(profileMessages.de, 'traceFallback', t),
    sessionPinned: (t: TraceParams) =>
      sessionRoutingMessages.de.tracePinned.replace('{model}', String(t.model ?? '')),
    sessionBlocked: (t: TraceParams) =>
      sessionRoutingMessages.de.traceBlocked + (t.message ? `: ${t.message}` : ''),
    sessionKept: () => sessionRoutingMessages.de.traceKept,
    modelMissing: (t: TraceParams) => `Modell „${t.model}“ ist auf diesem Gateway nicht verfügbar`,
    modelNotAllowedTeam: (t: TraceParams) => `${t.model} ist für Team ${t.name} nicht erlaubt`,
    modelNotAllowedKey: (t: TraceParams) => `${t.model} ist für Schlüssel ${t.name} nicht erlaubt`,
    keyValid: (t: TraceParams) =>
      t.team
        ? `Schlüssel gültig, Modell für ${t.team} erlaubt`
        : 'Schlüssel gültig, Modell erlaubt',
    agentRateLimit: (t: TraceParams) =>
      `Regel ${t.rule}: Agenten-Schlüssel dürfen höchstens ${t.rpm} Anfragen pro Minute senden`,
    localNoBudget: () => 'Lokales Modell: keine API-Kosten, Budgets gelten nicht',
    keyDailyLimit: (t: TraceParams) =>
      `Schlüssel ${t.key} hat sein Tageslimit von ${fmtLimit(t.limit ?? 0)} erreicht (${fmtUsd(t.spent ?? 0)} ausgegeben)`,
    keyMonthlyLimit: (t: TraceParams) =>
      `Schlüssel ${t.key} hat sein Monatslimit von ${fmtLimit(t.limit ?? 0)} erreicht (${fmtUsd(t.spent ?? 0)} ausgegeben)`,
    teamBudget: (t: TraceParams) =>
      `${t.team} hat ${t.percent}% seines Budgets von ${fmtLimit(t.budget ?? 0)} verbraucht`,
    offHours: (t: TraceParams) => `Außerhalb der Arbeitszeit ${t.from}–${t.to}`,
    blockedKeyNoFallback: () =>
      'Anfrage blockiert: dieser Schlüssel blockiert, statt auf ein lokales Modell zu wechseln',
    blockedNoLocalModel: () => 'Anfrage blockiert: kein lokales Modell eingerichtet',
    embeddings: (t: TraceParams) =>
      `Embeddings für ${p(t.count ?? 1, { one: '# Text', other: '# Texte' })}`,
    ruleSkippedEmbeddings: (t: TraceParams) =>
      `Regel ${t.rule} übersprungen: Embeddings bleiben bei ihrem Modell`,
    blockedEmbeddings: () =>
      'Anfrage blockiert: Embeddings können nicht auf ein anderes Modell wechseln',
    sentToLocal: (t: TraceParams) =>
      `${t.rule ? `Regel ${t.rule} greift → ` : ''}an ${t.model} · lokal gesendet`,
    withinBudget: (t: TraceParams) =>
      `Im Budget: ${[
        t.keyLimit != null
          ? `Schlüssel ${fmtUsd(t.keySpent ?? 0)} von ${fmtLimit(t.keyLimit)} heute`
          : null,
        t.team ? `${t.team} bei ${t.teamPercent}% von ${fmtLimit(t.teamBudget ?? 0)}` : null,
      ]
        .filter(Boolean)
        .join(' · ')}`,
    noBudget: () => 'Kein Budget festgelegt',
    noPii: () => 'Keine sensiblen Daten in der Anfrage',
    piiBlocked: (t: TraceParams) =>
      `Regel ${t.rule}: Anfrage enthält ${describePii(t.pii, pii)}; Cloud-Modelle sind dafür gesperrt`,
    piiMasked: (t: TraceParams) =>
      `${describePii(t.pii, pii)} gefunden; im Protokoll maskiert${t.local ? ', Modell ist lokal' : ''}`,
    sentTo: (t: TraceParams) =>
      `An ${t.model}${t.local ? ' · lokal' : ''} (${t.provider}) gesendet`,
    upstreamError: (t: TraceParams) => `${t.message}`,
    providerFailed: (t: TraceParams) => `${t.provider} ist ausgefallen: ${t.message}`,
    failover: (t: TraceParams) => `${t.provider} nicht erreichbar → an ${t.model} · lokal gesendet`,
    promptCut: (t: TraceParams) =>
      `Ollama hat ${fmtNumber(t.kept ?? 0)} von etwa ${fmtNumber(t.sent ?? 0)} Prompt-Tokens behalten und den Anfang verworfen: Der Kontext ist zu klein. Starten Sie Ollama mit OLLAMA_CONTEXT_LENGTH=32768.`,
    cacheHit: (t: TraceParams) =>
      `Aus dem Cache beantwortet: ${fmtUsd(t.saved ?? 0)} nicht ausgegeben`,
  },

  models: {
    title: 'Modelle & Anbieter',
    subtitle:
      'Wohin Anfragen gehen und unter welchen Namen Ihre Leute und Agenten Modelle aufrufen.',
    addProvider: 'Anbieter hinzufügen',
    providers: 'Anbieter',
    noProviders:
      'Noch keine Anbieter. Fügen Sie Ollama für lokale Modelle oder eine Cloud-API mit Schlüssel hinzu.',
    kinds: {
      openai: {
        label: 'OpenAI-kompatibel',
        hint: 'OpenAI oder jede API mit /v1/chat/completions: vLLM, LM Studio, LiteLLM, Together und andere',
      },
      anthropic: { label: 'Anthropic', hint: 'Claude-Modelle über die Messages-API' },
      ollama: {
        label: 'Ollama',
        hint: 'Lokale Modelle, kein Schlüssel nötig. Läuft Spillway in Docker, erreicht man Ollama auf demselben Rechner unter host.docker.internal.',
      },
    },
    localFree: 'Lokal · kostenlos',
    keySet: 'Schlüssel hinterlegt',
    noKey: 'Kein Schlüssel',
    deleteConfirm: (name) => `${name} und seine Modelle löschen?`,
    count: (n) => p(n, { one: '# Modell', other: '# Modelle' }),
    addModels: 'Modelle hinzufügen',
    modelsTitle: 'Modelle',
    introBefore: 'Clients senden den Namen im Feld',
    introAfter:
      ' – wird ein Modell umbenannt, funktionieren Clients mit dem alten Namen nicht mehr. Preise in US-Dollar pro Million Tokens; daraus werden Budgets und Ersparnis berechnet.',
    nameCol: 'Name für Clients',
    displayCol: 'Anzeigename',
    providerCol: 'Anbieter',
    upstreamCol: 'Modell beim Anbieter',
    inputCol: 'Eingabe $/1M',
    outputCol: 'Ausgabe $/1M',
    cachedCol: 'Cache $/1M',
    cachedHint:
      'Preis für Eingabe-Tokens aus dem Prompt-Cache des Anbieters. Leer bedeutet ein Zehntel des Eingabepreises.',
    enabledCol: 'Aktiv',
    noModels: 'Noch keine Modelle. Nutzen Sie „Modelle hinzufügen“ bei einem Anbieter.',
    newProvider: 'Neuer Anbieter',
    baseUrl: 'Basis-URL',
    baseUrlHint: 'Leer lassen für die Standardadresse.',
    service: 'Dienst',
    otherService: 'Andere OpenAI-kompatible API',
    presetHints: {
      azure:
        'Ersetzen Sie YOUR-RESOURCE durch den Namen Ihrer Azure-Ressource und fügen Sie Modelle über ihre Deployment-Namen hinzu.',
      gemini: 'Verwenden Sie einen API-Schlüssel aus Google AI Studio.',
      openrouter: 'Ein Schlüssel für Hunderte Modelle; die Preise kommen von OpenRouter.',
      custom: 'vLLM, LM Studio, LiteLLM, Together und andere APIs mit /v1/chat/completions.',
    },
    fillIn: (part: string) => `Ersetzen Sie zuerst ${part} in der Adresse.`,
    apiKey: 'API-Schlüssel',
    keySaved:
      'Ein Schlüssel ist gespeichert. Leer lassen, um ihn zu behalten, oder einen neuen einfügen.',
    keyEncrypted: 'Wird mit dem Gateway-Geheimnis verschlüsselt gespeichert.',
    notNeeded: 'nicht nötig',
    savedPlaceholder: '•••••••• gespeichert',
    removeKey: 'Gespeicherten Schlüssel entfernen',
    ownHardware: 'Läuft auf eigener Hardware',
    ownHardwareHint:
      'Lokale Modelle kosten nichts, zählen nicht zu Budgets und dürfen Anfragen mit persönlichen Daten erhalten.',
    asking: (name) => `Frage ${name} nach seinen Modellen…`,
    filterLabel: 'Modelle filtern',
    filterPlaceholder: (n) => `${n} Modelle filtern, z. B. deepseek free`,
    noMatch: 'Keine passenden Modelle.',
    allAdded: (name) => `Alle Modelle von ${name} sind bereits hinzugefügt.`,
    manual: 'Oder Modell-IDs durch Komma getrennt eingeben',
    addN: (n) =>
      n ? `${p(n, { one: '# Modell', other: '# Modelle' })} hinzufügen` : 'Modelle hinzufügen',
    nameLabel: (model) => `Name von ${model} für Clients`,
    upstreamLabel: (model) => `Modell ${model} beim Anbieter`,
    displayLabel: (model) => `Anzeigename von ${model}`,
    inputLabel: (model) => `Eingabepreis von ${model}`,
    outputLabel: (model) => `Ausgabepreis von ${model}`,
    cachedLabel: (model) => `Cache-Eingabepreis von ${model}`,
    notSet: 'nicht gesetzt',
    noPrice:
      'Noch kein Preis: Anfragen zählen als kostenlos, und Budgets sehen dieses Modell nicht.',
    applyListPrice: (input, output) =>
      `Listenpreis übernehmen: ${input} Eingabe, ${output} Ausgabe`,
    perMillion: (input, output) => `${input} / ${output} pro 1M`,
    listNote: (date) =>
      `Modelle aus der Spillway-Preisliste (Stand: ${date}) bekommen ihren Preis beim Hinzufügen. Vergleichen Sie ihn mit der Preisseite Ihres Anbieters; ein leerer Preis heißt „noch nicht gesetzt“.`,
    enabledLabel: (model) => `${model} aktiv`,
    deleteModelConfirm: (name) => `${name} löschen?`,
  },

  settings: {
    title: 'Einstellungen & SSO',
    subtitle: 'Datenschutz, Umleitung und wer sich anmelden darf.',
    storage: 'Speicherung der Anfragen',
    keepPrompts: 'Anfragen und Antworten im Protokoll behalten',
    keepPromptsHint:
      'E-Mail-Adressen, Telefonnummern, Karten- und Ausweisnummern sowie API-Schlüssel werden vor dem Schreiben maskiert.',
    keepDays: 'Texte aufbewahren, Tage',
    keepDaysHint:
      'Danach bleiben nur die Zahlen: Tokens, Kosten, Route. Budgets funktionieren weiter.',
    rerouting: 'Lokales Modell für Umleitungen',
    reroutingText:
      'Budgets und Regeln schicken Anfragen hierher, statt sie zu blockieren. Ohne Modell bekommen diese Anfragen eine klare Fehlermeldung.',
    noneBlock: 'Keins: stattdessen blockieren',
    addOllama: 'Fügen Sie zuerst einen Ollama-Anbieter und seine Modelle hinzu.',
    timeZone: 'Zeitzone',
    timeZoneText:
      'Nach dieser Uhr werden Tageslimits um Mitternacht zurückgesetzt und Arbeitszeiten geprüft, egal wo der Server läuft.',
    serverZone: (zone) => `Zeitzone des Servers (${zone})`,
    pickMine: (zone) => `Meine Zeitzone verwenden (${zone})`,
    nowThere: (time) => `Dort ist es jetzt ${time}.`,
    onFailure: 'Auch antworten, wenn ein Cloud-Anbieter ausfällt',
    onFailureHint:
      'Bei Ausfällen, Zeitüberschreitungen und Ratenlimits antwortet das lokale Modell statt eines Fehlers.',
    sso: 'Single Sign-on',
    connected: 'Verbunden',
    notSetUp: 'Nicht eingerichtet',
    free: 'Kostenlos, wie alles hier.',
    issuer: 'Issuer',
    domains: 'Erlaubte Domains',
    onlyAdded: 'Nur unten hinzugefügte Personen',
    becomeAdmins: 'Werden Admins',
    redirect: 'Redirect-URI',
    ssoIntro:
      'Funktioniert mit Google Workspace, Microsoft Entra ID oder jedem OpenID-Connect-Anbieter. Registrieren Sie dort eine App mit dieser Redirect-URI, setzen Sie die Variablen und starten Sie neu:',
    people: 'Personen',
    peopleIntro:
      'Fügen Sie eine Person hinzu und schicken Sie ihr den Einladungslink, oder lassen Sie sie per SSO anmelden. Danach kann sie eigene Schlüssel erstellen.',
    linkTitle: (email) => `Link für ${email}`,
    linkHint: (date) =>
      `Einmal gültig, bis ${date}. Per Messenger verschicken; Spillway verschickt keine Einladungen per E-Mail.`,
    copyLink: 'Link kopieren',
    newLink: 'Neuer Link',
    newLinkHint: 'Neuen Einladungs- oder Passwort-Reset-Link erstellen',
    invited: 'Eingeladen',
    noPassword: 'Noch kein Passwort',
    addPerson: 'Person hinzufügen',
    person: 'Person',
    lastSignIn: 'Letzte Anmeldung',
    active: 'Aktiv',
    noPeople: 'Noch keine Personen.',
    roleLabel: (email) => `Rolle von ${email}`,
    teamLabel: (email) => `Team von ${email}`,
    activeLabel: (email) => `${email} aktiv`,
    cache: 'Antwort-Cache',
    cacheText:
      'Schickt derselbe Schlüssel dieselbe Anfrage noch einmal, bekommt er die gespeicherte Antwort: kein Anbieteraufruf, keine Kosten. Nützlich für n8n-Workflows, Klassifizierung und das erneute Indexieren derselben Dokumente.',
    cacheOn: 'Wiederholte Anfragen aus dem Cache beantworten',
    cacheOnHint:
      'Antworten werden für die unten angegebene Zeit unmaskiert gespeichert, damit sie unverändert zurückgegeben werden können. Prompts mit personenbezogenen Daten und gestreamte Antworten werden nie zwischengespeichert; ein Client kann den Cache mit Cache-Control: no-cache umgehen.',
    cacheHours: 'Antworten aufbewahren, Stunden',
    cacheStats: (entries, hits) =>
      `${p(entries, { one: '# Antwort', other: '# Antworten' })} im Cache, ${p(hits, { one: 'einmal', other: '#-mal' })} wiederverwendet`,
    clearCache: 'Cache leeren',
    notifications: 'Benachrichtigungen',
    notificationsText:
      'Hinweise, wenn Budgets aufgebraucht sind oder ein Anbieter ausfällt, und jeden Montag um 9:00 Uhr (Uhrzeit des Gateways) eine Zusammenfassung.',
    channels: { slack: 'Slack', teams: 'Microsoft Teams', email: 'E-Mail' },
    webhook: (channel) => `${channel}-Webhook-URL`,
    slackHint:
      'In Slack: eine App mit Incoming Webhooks. Webhooks von Mattermost und Rocket.Chat funktionieren auch.',
    teamsHint: 'In Teams: Workflows → „Post to a channel when a webhook request is received“.',
    removeWebhook: 'Entfernen',
    emailsTo: 'E-Mail an',
    emailsHint: (from) => `Durch Kommas getrennt. Absender: ${from}.`,
    emailsOff: 'Für E-Mails SMTP_URL in .env setzen und Spillway neu starten.',
    sendTest: 'Test senden',
    noChannels: 'Fügen Sie zuerst einen Webhook oder eine E-Mail-Adresse hinzu.',
    delivered: 'zugestellt',
    alerts: {
      budget: {
        label: 'Budgets und Limits',
        hint: 'Ein Team erreicht seine Schwelle oder sein Budget, ein Schlüssel sein Tages- oder Monatslimit.',
      },
      outages: {
        label: 'Ausfälle von Anbietern',
        hint: 'Ein Cloud-Anbieter fällt aus und antwortet später wieder.',
      },
      weekly: {
        label: 'Montagszusammenfassung',
        hint: 'Ausgaben und Ersparnis der Vorwoche, die größten Verbraucher und die Team-Budgets.',
      },
    },
  },
};
