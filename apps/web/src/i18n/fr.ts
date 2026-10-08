import { fmtLimit, fmtNumber, fmtUsd } from '../lib/format.ts';
import { comparisonMessages } from './comparisons.ts';
import type { Messages } from './en.ts';
import { describePii, plural, type TraceParams } from './helpers.ts';
import { profileErrors, profileMessages, profileTrace } from './profiles.ts';
import { budgetMessages, budgetTrace } from './reservations.ts';

const p = plural('fr');

const pii = {
  secret: 'clés API',
  email: 'e-mails',
  card: 'numéros de carte',
  iban: 'IBAN',
  ssn: 'SSN',
  nino: 'numéros NI britanniques',
  snils: 'numéros SNILS',
  passport: 'numéros de passeport',
  inn: 'numéros INN',
  phone: 'numéros de téléphone',
  ip: 'adresses IP',
};

const times = (n: number) => p(n, { one: '# fois', other: '# fois' });

export const fr: Messages = {
  comparisons: comparisonMessages.fr,
  reservations: budgetMessages.fr,
  profiles: profileMessages.fr,
  common: {
    save: 'Enregistrer',
    saved: 'Enregistré',
    cancel: 'Annuler',
    close: 'Fermer',
    copy: 'Copier',
    copied: 'Copié',
    on: 'Activé',
    off: 'Désactivé',
    none: 'aucun',
    local: 'local',
    noTeam: 'Sans équipe',
    team: 'Équipe',
    name: 'Nom',
    email: 'E-mail',
    password: 'Mot de passe',
    language: 'Langue',
    model: 'Modèle',
    key: 'Clé',
    type: 'Type',
    status: 'Statut',
    role: 'Rôle',
    member: 'Membre',
    admin: 'Admin',
    period: 'Période',
    edit: (name) => `Modifier ${name}`,
    delete: (name) => `Supprimer ${name}`,
  },
  kinds: { person: 'Personne', device: 'Appareil', agent: 'Agent' },
  results: {
    ok: 'OK',
    rerouted: 'Redirigée',
    blocked_pii: 'Bloquée · données',
    blocked_budget: 'Bloquée · budget',
    blocked_model: 'Bloquée · modèle',
    rate_limited: 'Limite de débit',
    error: 'Erreur',
  },
  pii,
  masked: {
    label: (kind) => `[${kind} masqué]`,
    kinds: {
      secret: 'clé',
      email: 'e-mail',
      card: 'carte',
      iban: 'IBAN',
      ssn: 'SSN',
      nino: 'numéro NI',
      snils: 'SNILS',
      passport: 'passeport',
      inn: 'INN',
      phone: 'téléphone',
      ip: 'IP',
    },
  },

  errors: {
    ...profileErrors.fr,
    'Wrong setup code. Spillway prints the setup link in its logs.':
      'Code de configuration incorrect. Spillway écrit le lien dans son journal au démarrage.',
    'Your email comes from single sign-on and cannot be changed here':
      'Votre e-mail vient de l’authentification unique (SSO) et ne peut pas être modifié ici',
    'This is a read-only demo with made-up data. Install Spillway to try changes.':
      'Ceci est une démo en lecture seule avec des données fictives. Installez Spillway pour essayer des modifications.',
    'A team with this name already exists': 'Une équipe porte déjà ce nom',
    'This invite link is invalid or has expired': 'Ce lien d’invitation est invalide ou a expiré',
    'Person not found': 'Personne introuvable',
    'Wrong email or password': 'E-mail ou mot de passe incorrect',
    'Too many attempts. Try again in 15 minutes.': 'Trop de tentatives. Réessayez dans 15 minutes.',
    'Sign in to continue': 'Connectez-vous pour continuer',
    'Only admins can do this': 'Seuls les admins peuvent faire cela',
    'Spillway is already set up. Sign in instead.': 'Spillway est déjà configuré. Connectez-vous.',
    'Use at least 8 characters': 'Au moins 8 caractères',
    'Someone already uses this email': 'Cet e-mail est déjà utilisé',
    'The current password is wrong': 'Le mot de passe actuel est incorrect',
    'This person is already added': 'Cette personne est déjà ajoutée',
    'You cannot demote or disable yourself':
      'Vous ne pouvez pas vous rétrograder ni vous désactiver',
    'Provider not found': 'Fournisseur introuvable',
    'A model with this name already exists': 'Un modèle porte déjà ce nom',
    'Request not found': 'Requête introuvable',
    'Internal error': 'Erreur interne',
    'SSO is not configured': 'Le SSO n’est pas configuré',
    'Could not reach the identity provider': 'Impossible de joindre le fournisseur d’identité',
    'Sign-in expired, try again': 'La connexion a expiré, réessayez',
    'This account is disabled': 'Ce compte est désactivé',
  },

  nav: {
    routingProfiles: profileMessages.fr.title,
    comparisons: 'Comparer les modèles',
    main: 'Menu principal',
    overview: 'Vue d’ensemble',
    keys: 'Clés',
    budgets: 'Budgets et règles',
    logs: 'Journal des requêtes',
    models: 'Modèles et fournisseurs',
    settings: 'Réglages et SSO',
    account: 'Compte',
    openMenu: 'Ouvrir le menu',
    closeMenu: 'Fermer le menu',
    signOut: 'Se déconnecter',
    healthy: 'Passerelle opérationnelle',
    source: 'Code source',
    degraded: (providers) => `En panne : ${providers}`,
    degradedHint:
      'La dernière requête vers ce fournisseur ces 10 dernières minutes a échoué. Le modèle local répond à sa place quand c’est possible.',
    offline: 'Pas de connexion à la passerelle',
    offlineBanner:
      'Pas de connexion à la passerelle. Les chiffres de cette page peuvent être périmés ; nouvel essai toutes les 15 secondes.',
    demoBanner:
      'Démo en lecture seule : une entreprise fictive avec un trafic généré. Tout ce qui la modifierait est désactivé.',
    demoInstall: 'Installer Spillway →',
    providers: (all, local) =>
      `${p(all, { one: '# fournisseur', other: '# fournisseurs' })} · ${local} local`,
    selfHosted: (version) => `v${version} · auto-hébergé`,
  },

  login: {
    title: 'Connexion',
    subtitle: 'Gérez les clés, les budgets et le journal des requêtes.',
    orPassword: 'ou avec un mot de passe',
    submit: 'Se connecter',
    submitting: 'Connexion…',
  },

  setup: {
    code: 'Code de configuration',
    codeHint:
      'Spillway écrit un lien qui le contient dans son journal au démarrage : docker logs spillway',
    title: 'Bienvenue dans Spillway',
    subtitle:
      'Créez le compte administrateur. Il sert à vous connecter, à relier des fournisseurs d’IA et à distribuer des clés.',
    name: 'Votre nom',
    passwordHint: 'Au moins 8 caractères.',
    confirm: 'Répétez le mot de passe',
    mismatch: 'Les mots de passe ne correspondent pas',
    submit: 'Créer le compte',
    submitting: 'Création…',
    note: 'Cette page ne s’affiche que tant qu’aucun compte n’existe.',
    orSso: 'ou avec un mot de passe',
    ssoHint:
      'Avec l’authentification unique, la première personne d’un domaine autorisé devient admin.',
  },

  invite: {
    title: 'Rejoindre Spillway',
    subtitle: (email) =>
      `Vous avez été invité en tant que ${email}. Choisissez votre nom et un mot de passe.`,
    resetTitle: 'Nouveau mot de passe',
    resetSubtitle: (email) =>
      `Pour ${email}. Les navigateurs connectés avec l’ancien mot de passe seront déconnectés.`,
    submit: 'Rejoindre',
    resetSubmit: 'Enregistrer le mot de passe',
    submitting: 'Enregistrement…',
    checking: 'Vérification du lien…',
    toSignIn: 'Aller à la connexion',
  },

  welcome: {
    label: 'Visite guidée',
    skip: 'Passer',
    next: 'Suivant',
    back: 'Retour',
    start: 'Commencer la configuration',
    finish: 'Compris',
    step: (current, total) => `${current} sur ${total}`,
    slides: [
      {
        title: 'Une passerelle pour tous les modèles d’IA',
        text: 'Personnes, appareils et agents reçoivent leur propre clé Spillway au lieu de partager les clés des fournisseurs. Chaque requête passe par ici : vous voyez qui a utilisé quoi et pour combien.',
      },
      {
        title: 'Des limites qui n’arrêtent pas le travail',
        text: 'Clés et équipes ont des budgets journaliers ou mensuels. Quand l’un est épuisé, ou qu’un fournisseur cloud tombe, les requêtes basculent discrètement vers un modèle local au lieu d’échouer.',
      },
      {
        title: 'Les données privées restent en interne',
        text: 'Numéros de carte, passeports et clés API n’atteignent jamais un modèle cloud, et les données personnelles sont masquées dans le journal. Les modèles locaux peuvent toujours les voir.',
      },
      {
        title: 'Cinq étapes jusqu’à la première requête',
        text: 'Une liste sur la page Vue d’ensemble vous guide : relier un fournisseur, ajouter des modèles, choisir un modèle local, créer une clé et envoyer une requête.',
      },
    ],
    memberSlides: [
      {
        title: 'Votre clé pour tous les modèles d’IA',
        text: 'Créez une clé Spillway pour chaque application ou appareil. Votre admin décide des modèles autorisés et du montant qu’elle peut dépenser.',
      },
      {
        title: 'Voyez ce que vous envoyez',
        text: 'Le journal montre chaque requête, le modèle qui a répondu et son coût. Les données personnelles sont masquées avant tout enregistrement.',
      },
    ],
  },

  checklist: {
    title: 'Premiers pas',
    progress: (done, total) => `${done} sur ${total} terminées`,
    hide: 'Masquer',
    allDone: 'Tout est prêt. Spillway peut être confié à votre équipe.',
    steps: {
      provider: {
        title: 'Relier un fournisseur',
        text: 'Une API cloud avec sa clé (OpenAI, Anthropic, OpenRouter…) ou Ollama pour les modèles locaux.',
        action: 'Ajouter un fournisseur',
      },
      models: {
        title: 'Ajouter des modèles',
        text: 'Choisissez les modèles autorisés et indiquez leurs prix pour suivre les dépenses.',
        action: 'Ajouter des modèles',
      },
      local: {
        title: 'Choisir un modèle local',
        text: 'Les requêtes y vont quand un budget est épuisé ou que le cloud est en panne. Facultatif, mais c’est ce qui évite les interruptions.',
        action: 'Ouvrir les réglages',
      },
      key: {
        title: 'Créer une clé',
        text: 'Une par personne, appareil ou agent. Limites et accès aux modèles se règlent par clé.',
        action: 'Créer une clé',
      },
      request: {
        title: 'Envoyer la première requête',
        text: 'Utilisez la clé dans une appli de chat, un IDE ou curl. La requête apparaît dans le journal en quelques secondes.',
        action: 'Ouvrir le journal',
      },
    },
  },

  account: {
    title: 'Compte',
    subtitle: 'Votre nom, e-mail, mot de passe et langue.',
    profile: 'Profil',
    emailFromSso: 'Votre e-mail vient de l’authentification unique (SSO).',
    password: 'Mot de passe',
    current: 'Mot de passe actuel',
    newPassword: 'Nouveau mot de passe',
    confirm: 'Répétez le nouveau mot de passe',
    change: 'Changer le mot de passe',
    changed: 'Mot de passe changé. Les autres navigateurs doivent se reconnecter.',
    noPassword:
      'Vous vous connectez par SSO. Définissez un mot de passe pour pouvoir aussi vous connecter par e-mail.',
    languageHint: 'Enregistré dans ce navigateur.',
    tour: 'Premiers pas',
    tourText: 'Afficher à nouveau la visite guidée et la liste sur la Vue d’ensemble.',
    tourButton: 'Afficher à nouveau',
  },

  chart: { cloud: 'Cloud', local: 'Local', day: 'Jour' },

  overview: {
    title: 'Vue d’ensemble',
    periods: { '7d': '7 jours', '30d': '30 jours', month: 'Ce mois-ci' },
    lastDays: (days) => `${days} derniers jours`,
    allTeams: 'toutes les équipes',
    yourKeys: 'vos clés',
    activeKeys: (n) => p(n, { one: '# clé active', other: '# clés actives' }),
    exportCsv: 'Exporter en CSV',
    keyNumbers: 'Chiffres clés',
    spendThisMonth: 'Dépenses ce mois-ci',
    spendPeriod: (period) => `Dépenses · ${period}`,
    budgetUsed: 'Budget consommé',
    budgetLine: (percent, budget, date) =>
      `${percent} % du budget de ${budget} · remis à zéro le ${date}`,
    budgetsMonthly: 'Les budgets d’équipe sont mensuels',
    noBudgets: 'Aucun budget d’équipe pour l’instant',
    saved: (amount) => `${amount} économisés grâce aux modèles locaux`,
    savedCache: (amount) => `${amount} économisés grâce au cache`,
    requests: 'Requêtes',
    vsPrevious: (change) => `${change} % par rapport à la période précédente`,
    from: (parts) => `de ${parts}`,
    people: (n) => p(n, { one: '# personne', other: '# personnes' }),
    sharedKeys: (n) => p(n, { one: '# clé partagée', other: '# clés partagées' }),
    devices: (n) => p(n, { one: '# appareil', other: '# appareils' }),
    agents: (n) => p(n, { one: '# agent', other: '# agents' }),
    noTraffic: 'Pas encore de trafic',
    servedLocal: 'Servies par des modèles locaux',
    shareLocal: 'Part servie localement',
    localRequests: (n) =>
      p(n, { one: '# requête sans coût d’API', other: '# requêtes sans coût d’API' }),
    blocked: 'Requêtes bloquées',
    blockedPii: (n) => `${n} contenaient des données sensibles`,
    blockedOther: (n) => `${n} pour budget, limite de débit ou accès au modèle`,
    perDay: 'Requêtes par jour · 14 derniers jours',
    perDayLabel: 'Requêtes par jour',
    cloudPaid: 'Cloud (payant)',
    localFree: 'Local (gratuit)',
    attention: 'À surveiller',
    viewLog: 'Voir le journal',
    nothing:
      'Rien à signaler. Limites, blocages, fournisseurs en panne et clés inutilisées apparaîtront ici.',
    topSpenders: 'Plus gros consommateurs',
    requestsCol: 'Requêtes',
    spend: 'Dépenses',
    share: 'Part des dépenses',
    shareOf: (name) => `Part des dépenses de ${name}`,
    noRequests: 'Aucune requête sur cette période.',
    byModel: 'Dépenses par modèle',
    modelSpend: (name) => `Dépenses pour ${name}`,
    noPaid: 'Aucune requête payante sur cette période.',
    localReq: (n) => `${n} req. · 0 $`,
  },

  alerts: {
    keyLimit: (a) =>
      `${a.key} a atteint ${a.percent} % de sa limite journalière de ${fmtLimit(a.limit)}`,
    keyUnused: (a) =>
      `La clé ${a.key} n’a pas servi depuis ${p(a.days, { one: '# jour', other: '# jours' })}`,
    considerRevoking: 'Envisagez de la révoquer',
    modelNoPrice: (a) =>
      `Modèles cloud sans prix : ${a.models.length}. Leurs coûts ne comptent pas dans les budgets`,
    piiBlocked: (a) =>
      `${p(a.count, { one: '# requête', other: '# requêtes' })} vers des modèles cloud bloquée(s) : données sensibles détectées`,
    teamOverBudget: (a) =>
      `${a.team} a dépassé son budget mensuel ; les requêtes vont aux modèles locaux`,
    spentOf: (spent, budget) => `${spent} sur ${budget}`,
    promptCut: (a) =>
      `${a.model} a perdu le début de ${p(a.count, { one: '# long prompt', other: '# longs prompts' })} au cours des dernières 24 heures : le contexte d'Ollama est trop petit`,
    providerFailing: (a) =>
      `${a.provider} a échoué ${times(a.failed + a.rescued)} ces dernières 24 heures` +
      (a.rescued ? ` ; le modèle local a répondu ${times(a.rescued)}` : ''),
  },

  keys: {
    title: 'Clés',
    subtitle: 'Une clé par personne, appareil ou agent. Révoquez-en une sans toucher aux autres.',
    newKey: 'Nouvelle clé',
    allKeys: 'Toutes les clés',
    keyType: 'Type de clé',
    filterAll: (n) => `Toutes ${n}`,
    filterPeople: (n) => `Personnes ${n}`,
    filterDevices: (n) => `Appareils ${n}`,
    filterAgents: (n) => `Agents ${n}`,
    search: 'Rechercher des clés',
    searchPlaceholder: 'Clé ou propriétaire',
    todayVsLimit: 'Aujourd’hui / limite journalière',
    lastUsed: 'Dernière utilisation',
    noMatch: 'Aucune clé ne correspond.',
    none: 'Pas encore de clés. Créez-en une par personne, appareil ou agent.',
    teamSuffix: (team) => `équipe ${team}`,
    noOwner: 'Sans propriétaire',
    limitUsed: (name) => `Limite journalière de ${name} consommée`,
    todayNoLimit: (amount) => `${amount} aujourd’hui · sans limite`,
    status: {
      revoked: 'Révoquée',
      localOnly: 'Local uniquement',
      limitReached: 'Limite atteinte',
      nearLimit: 'Proche de la limite',
      active: 'Active',
    },
    editKey: 'Modifier la clé',
    namePlaceholder: 'anna-macbook',
    owner: 'Propriétaire',
    nobody: 'Personne (clé d’équipe)',
    ownersTeam: 'Équipe du propriétaire',
    allowedModels: 'Modèles autorisés',
    everything: 'Tout ce que l’équipe peut utiliser',
    daily: 'Limite par jour, $',
    monthly: 'Limite par mois, $',
    fallback: 'Limite atteinte ou cloud en panne ? Utiliser un modèle local',
    fallbackTo: (model) => `Les requêtes vont à ${model} au lieu d’échouer.`,
    fallbackNone:
      'Choisissez d’abord un modèle local dans les réglages ; d’ici là, les requêtes sont bloquées.',
    adminSets: 'Les limites de vos clés sont fixées par un admin.',
    revoke: 'Révoquer',
    revokeConfirm: (name) =>
      `Révoquer ${name} ? Les applications qui l’utilisent cessent aussitôt de fonctionner.`,
    create: 'Créer la clé',
    keyCreated: 'Clé créée',
    ready: (name) => `La clé pour ${name} est prête`,
    copyNow:
      'Copiez-la maintenant. Spillway ne garde qu’une empreinte et ne pourra plus l’afficher.',
    copyKey: 'Copier la clé',
    connect: 'Connecter un client',
    client: 'Client',
    modelPlaceholder: '<nom du modèle>',
  },

  budgets: {
    title: 'Budgets et règles',
    subtitle:
      'Limites par équipe et règles que la passerelle vérifie à chaque requête, de haut en bas.',
    addTeam: 'Ajouter une équipe',
    teamBudgets: 'Budgets d’équipe',
    teamBudgetsMonth: (month) => `Budgets d’équipe · ${month}`,
    noTeams:
      'Pas encore d’équipes. Une équipe a un budget mensuel et décide des modèles autorisés pour ses clés.',
    routingRules: 'Règles de routage',
    localName: (model) => `${model} · local`,
    localUnset: 'le modèle local (à choisir dans les réglages)',
    modelAccess: 'Accès aux modèles',
    modelAccessTitle: 'Accès aux modèles par équipe',
    narrow: 'Une clé peut restreindre cet accès, jamais l’élargir',
    addTeamsModels: 'Ajoutez des équipes et des modèles pour décider qui peut utiliser quoi.',
    teamName: 'Nom de l’équipe',
    monthlyBudget: 'Budget mensuel, $',
    budgetPlaceholder: 'Budget, $',
    noBudget: (spent, keys) =>
      `Sans budget · ${spent} dépensés · ${p(keys, { one: '# clé', other: '# clés' })}`,
    over: 'Budget dépassé · les requêtes vont aux modèles locaux',
    onTrack: (forecast, date) => `Dans les clous · prévision ${forecast} au ${date}`,
    closeTo: (forecast, date) => `Proche du budget · prévision ${forecast} au ${date}`,
    teamMonthlyBudget: (team) => `Budget mensuel de ${team}`,
    changeBudget: 'Modifier le budget',
    spentOf: (spent, budget) => `${spent} sur ${budget}`,
    budgetUsed: (team) => `Budget de ${team} consommé`,
    whenLabel: 'SI',
    thenLabel: 'ALORS',
    budgetBefore: 'L’équipe a dépensé',
    budgetAfter: '% ou plus de son budget mensuel',
    thresholdLabel: 'Seuil du budget, en pourcentage',
    sendTo: (local) => `Envoyer la requête à ${local}`,
    piiWhen:
      'La requête contient des numéros de carte, des IBAN, des SSN, des numéros de passeport ou d’identité, ou des clés API',
    piiThen: 'Bloquer les modèles cloud, autoriser les locaux',
    agentWhen: 'Le type de clé est Agent',
    agentBefore: 'Au plus',
    agentAfter: 'requêtes par minute',
    rpmLabel: 'Requêtes par minute',
    offBefore: 'L’heure est en dehors de',
    startLabel: 'Début de journée',
    endLabel: 'Fin de journée',
    offThen: 'Modèles locaux uniquement',
    zoneHint: 'Fuseau horaire de la passerelle. Modifiable dans les paramètres.',
    matched: (n) => `Déclenchée ${times(n)} ce mois-ci`,
    discard: 'Annuler les changements',
    saveRules: 'Enregistrer les règles',
    allowed: 'Autorisé',
    notAllowed: 'Non autorisé',
    toggle: 'Changer l’accès',
  },

  logs: {
    title: 'Journal des requêtes',
    subtitle: 'Chaque requête : qui l’a envoyée, où elle est allée, son coût et pourquoi.',
    live: 'En direct',
    export: 'Exporter',
    allKeys: 'Toutes les clés',
    allModels: 'Tous les modèles',
    result: 'Résultat',
    allResults: 'Tous les résultats',
    last24h: 'Dernières 24 heures',
    last7d: '7 derniers jours',
    last30d: '30 derniers jours',
    requests: 'Requêtes',
    time: 'Heure',
    route: 'Demandé → servi par',
    tokensInOut: 'Tokens entrée / sortie',
    cost: 'Coût',
    empty: 'Aucune requête ne correspond. Envoyez-en une avec une clé de la page Clés.',
    held: 'retenue',
    blocked: 'bloquée',
    titles: {
      ok: 'Servie',
      rerouted: 'Redirigée vers un modèle local',
      outage: 'Cloud indisponible : réponse locale',
      blocked_pii: 'Bloquée : données sensibles',
      blocked_budget: 'Bloquée : budget dépassé',
      blocked_model: 'Bloquée : modèle non autorisé',
      rate_limited: 'Retenue : limite de débit',
      error: 'Échec chez le fournisseur',
    },
    details: 'Détails de la requête',
    askedFor: 'Demandé',
    servedBy: 'Servi par',
    tokens: 'Tokens',
    tokensValue: (input, output) => `${input} en entrée · ${output} en sortie`,
    savedAmount: (amount) => `(${amount} économisés)`,
    latency: 'Latence',
    client: 'Client',
    clientApi: (name) => `API ${name}`,
    streaming: 'en flux',
    why: 'Pourquoi',
    prompt: 'Requête',
    notStored: 'Non enregistrée.',
    response: 'Réponse',
    retention: (days) =>
      `Les requêtes sont conservées ${p(days, { one: '# jour', other: '# jours' })}, données personnelles masquées. Modifiable dans les réglages.`,
  },

  trace: {
    budgetReconciled: (t: TraceParams) => budgetTrace(budgetMessages.fr.traceReconciled, t),
    budgetReserved: (t: TraceParams) => budgetTrace(budgetMessages.fr.traceReserved, t),
    budgetReservationDenied: () => budgetMessages.fr.traceDenied,
    budgetEstimateUnknown: () => budgetMessages.fr.traceUnknown,
    budgetUncertain: (t: TraceParams) => budgetTrace(budgetMessages.fr.traceUnknownCharge, t),
    profileApplied: (t: TraceParams) => profileTrace(profileMessages.fr, 'traceApplied', t),
    profileSkipped: (t: TraceParams) => profileTrace(profileMessages.fr, 'traceSkipped', t),
    profileFallback: (t: TraceParams) => profileTrace(profileMessages.fr, 'traceFallback', t),
    modelMissing: (t: TraceParams) =>
      `Le modèle « ${t.model} » n’est pas disponible sur cette passerelle`,
    modelNotAllowedTeam: (t: TraceParams) =>
      `${t.model} n’est pas autorisé pour l’équipe ${t.name}`,
    modelNotAllowedKey: (t: TraceParams) => `${t.model} n’est pas autorisé pour la clé ${t.name}`,
    keyValid: (t: TraceParams) =>
      t.team ? `Clé valide, modèle autorisé pour ${t.team}` : 'Clé valide, modèle autorisé',
    agentRateLimit: (t: TraceParams) =>
      `Règle ${t.rule} : les clés d’agent ne peuvent envoyer plus de ${t.rpm} requêtes par minute`,
    localNoBudget: () => 'Modèle local : pas de coût d’API, les budgets ne s’appliquent pas',
    keyDailyLimit: (t: TraceParams) =>
      `La clé ${t.key} a atteint sa limite journalière de ${fmtLimit(t.limit ?? 0)} (${fmtUsd(t.spent ?? 0)} dépensés)`,
    keyMonthlyLimit: (t: TraceParams) =>
      `La clé ${t.key} a atteint sa limite mensuelle de ${fmtLimit(t.limit ?? 0)} (${fmtUsd(t.spent ?? 0)} dépensés)`,
    teamBudget: (t: TraceParams) =>
      `${t.team} est à ${t.percent} % de son budget de ${fmtLimit(t.budget ?? 0)}`,
    offHours: (t: TraceParams) => `En dehors des heures de travail ${t.from}–${t.to}`,
    blockedKeyNoFallback: () =>
      'Requête bloquée : cette clé bloque au lieu de passer à un modèle local',
    blockedNoLocalModel: () => 'Requête bloquée : aucun modèle local n’est configuré',
    embeddings: (t: TraceParams) =>
      `Embeddings pour ${p(t.count ?? 1, { one: '# texte', other: '# textes' })}`,
    ruleSkippedEmbeddings: (t: TraceParams) =>
      `Règle ${t.rule} ignorée : les embeddings restent sur leur modèle`,
    blockedEmbeddings: () =>
      'Requête bloquée : les embeddings ne peuvent pas passer à un autre modèle',
    sentToLocal: (t: TraceParams) =>
      `${t.rule ? `Règle ${t.rule} déclenchée → ` : ''}envoyée à ${t.model} · local`,
    withinBudget: (t: TraceParams) =>
      `Dans le budget : ${[
        t.keyLimit != null
          ? `clé ${fmtUsd(t.keySpent ?? 0)} sur ${fmtLimit(t.keyLimit)} aujourd’hui`
          : null,
        t.team ? `${t.team} à ${t.teamPercent} % de ${fmtLimit(t.teamBudget ?? 0)}` : null,
      ]
        .filter(Boolean)
        .join(' · ')}`,
    noBudget: () => 'Aucun budget défini',
    noPii: () => 'Aucune donnée sensible dans la requête',
    piiBlocked: (t: TraceParams) =>
      `Règle ${t.rule} : la requête contient ${describePii(t.pii, pii)} ; les modèles cloud sont bloqués`,
    piiMasked: (t: TraceParams) =>
      `Trouvé : ${describePii(t.pii, pii)} ; masqué dans le journal${t.local ? ', modèle local' : ''}`,
    sentTo: (t: TraceParams) => `Envoyée à ${t.model}${t.local ? ' · local' : ''} (${t.provider})`,
    upstreamError: (t: TraceParams) => `${t.message}`,
    providerFailed: (t: TraceParams) => `${t.provider} a échoué : ${t.message}`,
    failover: (t: TraceParams) => `${t.provider} indisponible → envoyée à ${t.model} · local`,
    promptCut: (t: TraceParams) =>
      `Ollama a gardé ${fmtNumber(t.kept ?? 0)} des quelque ${fmtNumber(t.sent ?? 0)} tokens du prompt et a supprimé le début : son contexte est trop petit. Lancez Ollama avec OLLAMA_CONTEXT_LENGTH=32768.`,
    cacheHit: (t: TraceParams) => `Réponse tirée du cache : ${fmtUsd(t.saved ?? 0)} non dépensés`,
  },

  models: {
    title: 'Modèles et fournisseurs',
    subtitle:
      'Où vont les requêtes, et les noms de modèles qu’utilisent vos équipes et vos agents.',
    addProvider: 'Ajouter un fournisseur',
    providers: 'Fournisseurs',
    noProviders:
      'Pas encore de fournisseurs. Ajoutez Ollama pour les modèles locaux, ou une API cloud avec sa clé.',
    kinds: {
      openai: {
        label: 'Compatible OpenAI',
        hint: 'OpenAI ou toute API avec /v1/chat/completions : vLLM, LM Studio, LiteLLM, Together et d’autres',
      },
      anthropic: { label: 'Anthropic', hint: 'Modèles Claude via l’API Messages' },
      ollama: {
        label: 'Ollama',
        hint: 'Modèles locaux, pas de clé nécessaire. Si Spillway tourne dans Docker, Ollama sur le même ordinateur est à host.docker.internal.',
      },
    },
    localFree: 'Local · gratuit',
    keySet: 'Clé API définie',
    noKey: 'Pas de clé API',
    deleteConfirm: (name) => `Supprimer ${name} et ses modèles ?`,
    count: (n) => p(n, { one: '# modèle', other: '# modèles' }),
    addModels: 'Ajouter des modèles',
    modelsTitle: 'Modèles',
    introBefore: 'Les clients envoient ce nom dans le champ',
    introAfter:
      ' ; renommer un modèle casse les clients qui utilisent encore l’ancien nom. Prix en dollars US par million de tokens ; ils servent aux budgets et aux économies.',
    nameCol: 'Nom pour les clients',
    displayCol: 'Nom affiché',
    providerCol: 'Fournisseur',
    upstreamCol: 'Modèle chez le fournisseur',
    inputCol: 'Entrée $/1M',
    outputCol: 'Sortie $/1M',
    cachedCol: 'Cache $/1M',
    cachedHint:
      'Prix des jetons d’entrée lus dans le cache du fournisseur. Vide : un dixième du prix d’entrée.',
    enabledCol: 'Activé',
    noModels: 'Pas encore de modèles. Utilisez « Ajouter des modèles » sur un fournisseur.',
    newProvider: 'Nouveau fournisseur',
    baseUrl: 'URL de base',
    baseUrlHint: 'Laissez vide pour l’adresse par défaut.',
    service: 'Service',
    otherService: 'Autre API compatible OpenAI',
    presetHints: {
      azure:
        'Remplacez YOUR-RESOURCE par le nom de votre ressource Azure, puis ajoutez les modèles par leurs noms de déploiement.',
      gemini: 'Utilisez une clé d’API de Google AI Studio.',
      openrouter: 'Une seule clé pour des centaines de modèles ; leurs prix viennent d’OpenRouter.',
      custom: 'vLLM, LM Studio, LiteLLM, Together et d’autres API avec /v1/chat/completions.',
    },
    fillIn: (part: string) => `Remplacez d’abord ${part} dans l’adresse.`,
    apiKey: 'Clé API',
    keySaved: 'Une clé est enregistrée. Laissez vide pour la garder, ou collez-en une nouvelle.',
    keyEncrypted: 'Chiffrée au repos avec le secret de la passerelle.',
    notNeeded: 'inutile',
    savedPlaceholder: '•••••••• enregistrée',
    removeKey: 'Supprimer la clé enregistrée',
    ownHardware: 'Tourne sur notre propre matériel',
    ownHardwareHint:
      'Les modèles locaux ne coûtent rien, ignorent les budgets et peuvent recevoir des données personnelles.',
    asking: (name) => `Demande de la liste des modèles à ${name}…`,
    filterLabel: 'Filtrer les modèles',
    filterPlaceholder: (n) => `Filtrer ${n} modèles, ex. deepseek free`,
    noMatch: 'Aucun modèle ne correspond.',
    allAdded: (name) => `Tous les modèles de ${name} sont déjà ajoutés.`,
    manual: 'Ou saisissez des identifiants de modèles, séparés par des virgules',
    addN: (n) =>
      n ? `Ajouter ${p(n, { one: '# modèle', other: '# modèles' })}` : 'Ajouter des modèles',
    nameLabel: (model) => `Nom de ${model} pour les clients`,
    upstreamLabel: (model) => `Modèle ${model} chez le fournisseur`,
    displayLabel: (model) => `Nom affiché de ${model}`,
    inputLabel: (model) => `Prix d’entrée de ${model}`,
    outputLabel: (model) => `Prix de sortie de ${model}`,
    cachedLabel: (model) => `Prix de l’entrée en cache de ${model}`,
    notSet: 'non défini',
    noPrice:
      'Pas encore de prix : les requêtes comptent comme gratuites et les budgets ignorent ce modèle.',
    applyListPrice: (input, output) =>
      `Utiliser le prix catalogue : ${input} en entrée, ${output} en sortie`,
    perMillion: (input, output) => `${input} / ${output} par 1M`,
    listNote: (date) =>
      `Les modèles de la liste de prix de Spillway (vérifiée en ${date}) reçoivent leur prix à l’ajout. Comparez-le avec la page de tarifs de votre fournisseur ; un prix vide signifie « pas encore défini ».`,
    enabledLabel: (model) => `${model} activé`,
    deleteModelConfirm: (name) => `Supprimer ${name} ?`,
  },

  settings: {
    title: 'Réglages et SSO',
    subtitle: 'Confidentialité, redirection et qui peut se connecter.',
    storage: 'Conservation des requêtes',
    keepPrompts: 'Garder requêtes et réponses dans le journal',
    keepPromptsHint:
      'E-mails, numéros de téléphone, de carte et de documents ainsi que les clés API sont masqués avant toute écriture.',
    keepDays: 'Conserver les textes, jours',
    keepDaysHint:
      'Ensuite seuls les chiffres restent : tokens, coût, routage. Les budgets continuent de fonctionner.',
    rerouting: 'Modèle local de secours',
    reroutingText:
      'Budgets et règles envoient les requêtes ici au lieu de les bloquer. Sans modèle, ces requêtes reçoivent une erreur claire.',
    noneBlock: 'Aucun : bloquer',
    addOllama: 'Ajoutez d’abord un fournisseur Ollama et ses modèles.',
    timeZone: 'Fuseau horaire',
    timeZoneText:
      'Les limites quotidiennes repartent à minuit et les heures de travail sont vérifiées selon cette horloge, où que tourne le serveur.',
    serverZone: (zone) => `Fuseau du serveur (${zone})`,
    pickMine: (zone) => `Utiliser mon fuseau (${zone})`,
    nowThere: (time) => `Il y est ${time}.`,
    onFailure: 'Répondre aussi ici quand un fournisseur cloud échoue',
    onFailureHint:
      'Pannes, délais dépassés et limites de débit reçoivent une réponse du modèle local plutôt qu’une erreur.',
    sso: 'Authentification unique',
    connected: 'Connectée',
    notSetUp: 'Non configurée',
    free: 'Gratuit, comme tout le reste ici.',
    issuer: 'Émetteur',
    domains: 'Domaines autorisés',
    onlyAdded: 'Seulement les personnes ajoutées ci-dessous',
    becomeAdmins: 'Deviennent admins',
    redirect: 'URI de redirection',
    ssoIntro:
      'Fonctionne avec Google Workspace, Microsoft Entra ID ou tout fournisseur OpenID Connect. Enregistrez-y une application avec cette URI de redirection, définissez les variables et redémarrez :',
    people: 'Personnes',
    peopleIntro:
      'Ajoutez quelqu’un et envoyez-lui le lien d’invitation, ou laissez-le se connecter par SSO. Il pourra ensuite créer ses propres clés.',
    linkTitle: (email) => `Lien pour ${email}`,
    linkHint: (date) =>
      `Valable une fois, jusqu’au ${date}. Envoyez-le par messagerie ; Spillway n’envoie pas les invitations par e-mail.`,
    copyLink: 'Copier le lien',
    newLink: 'Nouveau lien',
    newLinkHint: 'Créer un nouveau lien d’invitation ou de réinitialisation',
    invited: 'Invité',
    noPassword: 'Pas encore de mot de passe',
    addPerson: 'Ajouter',
    person: 'Personne',
    lastSignIn: 'Dernière connexion',
    active: 'Actif',
    noPeople: 'Personne pour l’instant.',
    roleLabel: (email) => `Rôle de ${email}`,
    teamLabel: (email) => `Équipe de ${email}`,
    activeLabel: (email) => `${email} actif`,
    cache: 'Cache des réponses',
    cacheText:
      'Quand la même clé renvoie la même requête, elle reçoit la réponse enregistrée : pas d’appel au fournisseur, pas de coût. Utile pour les workflows n8n, la classification et la réindexation des mêmes documents.',
    cacheOn: 'Répondre aux requêtes répétées depuis le cache',
    cacheOnHint:
      'Les réponses sont conservées sans masquage pendant la durée ci-dessous, pour être renvoyées telles quelles. Les prompts contenant des données personnelles et les réponses en streaming ne sont jamais mis en cache ; un client peut ignorer le cache avec Cache-Control: no-cache.',
    cacheHours: 'Conserver les réponses, heures',
    cacheStats: (entries, hits) =>
      `${p(entries, { one: '# réponse', other: '# réponses' })} en cache, réutilisées ${p(hits, { one: '# fois', other: '# fois' })}`,
    clearCache: 'Vider le cache',
    notifications: 'Notifications',
    notificationsText:
      'Des alertes quand un budget est épuisé ou qu’un fournisseur tombe en panne, et un résumé chaque lundi à 9 h, à l’heure de la passerelle.',
    channels: { slack: 'Slack', teams: 'Microsoft Teams', email: 'E-mail' },
    webhook: (channel) => `URL du webhook ${channel}`,
    slackHint:
      'Dans Slack : une app avec Incoming Webhooks. Les webhooks Mattermost et Rocket.Chat fonctionnent aussi.',
    teamsHint: 'Dans Teams : Workflows → « Post to a channel when a webhook request is received ».',
    removeWebhook: 'Supprimer',
    emailsTo: 'E-mail à',
    emailsHint: (from) => `Séparées par des virgules. Envoyé depuis ${from}.`,
    emailsOff: 'Pour envoyer des e-mails, définissez SMTP_URL dans .env et redémarrez Spillway.',
    sendTest: 'Envoyer un test',
    noChannels: 'Ajoutez d’abord un webhook ou une adresse e-mail.',
    delivered: 'remis',
    alerts: {
      budget: {
        label: 'Budgets et limites',
        hint: 'Une équipe atteint son seuil ou son budget, une clé sa limite quotidienne ou mensuelle.',
      },
      outages: {
        label: 'Pannes des fournisseurs',
        hint: 'Un fournisseur cloud tombe en panne, puis répond à nouveau.',
      },
      weekly: {
        label: 'Résumé du lundi',
        hint: 'Dépenses et économies de la semaine passée, plus gros consommateurs et budgets des équipes.',
      },
    },
  },
};
