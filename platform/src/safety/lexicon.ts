/**
 * SAFETY LEXICON — LOCAL DRAFT, PENDING CLINICAL SAFETY LEAD AND LANGUAGE-LEAD REVIEW.
 *
 * Phrase rules for possible safety concerns (spec section 10) in en-US and
 * es-US. Both rule sets run on every utterance in a supported locale because
 * code-switching is common; signal.locale records the call locale.
 *
 * This list is NOT complete and NOT infallible (spec: "keyword detection
 * itself is not complete or infallible"). It is one signal among explicit
 * phrases, contextual semantic detection, uncertain ASR, caller requests and
 * human intervention. It never diagnoses, scores severity or infers mental
 * state; a match only selects the deterministic human route.
 *
 * Rule ids are stable audit codes. Changing a pattern keeps the id; adding a
 * behaviourally new rule gets a new id; LEXICON_VERSION changes on any edit.
 *
 * Phrase grammar: see compilePhrase() in text.ts (a space = word boundary that
 * may cross a clause comma; `<w>` = one word). Sources are written against the
 * normalized form: lower case, no accents, no apostrophes.
 */
import type { SafetySignal } from "./ports.js";

export const LEXICON_VERSION = "safety-lexicon.2026-10-17.draft.2";
/** The coding agent cannot approve clinical content (spec sections 5 and 16). */
export const LEXICON_APPROVAL_STATUS = "PENDING_CLINICAL_APPROVAL" as const;

export type SubjectSpec =
  | { kind: "fixed"; subject: SafetySignal["subject"] }
  /** Scan backwards in the clause: third-party noun/pronoun => THIRD_PARTY, first person => SELF, else default. */
  | { kind: "infer"; fallback: SafetySignal["subject"] };

export interface PhraseRuleSpec {
  ruleId: string;
  source: "EXPLICIT_PHRASE" | "CALLER_REQUEST";
  baseStrength: SafetySignal["strength"];
  subject: SubjectSpec;
  /** Temporal value when no recency or historical cue is present. */
  defaultTemporal: "CURRENT" | "UNKNOWN";
  /** UNRESOLVED base strength becomes CREDIBLE when an explicit recency cue sits in the same clause. */
  upgradeOnRecency: boolean;
  /** Ambiguous phrases are not raised when the same sentence is about an administrative object (frustration). */
  suppressWithAdminContext: boolean;
  patterns: readonly string[];
}

const SELF: SubjectSpec = { kind: "fixed", subject: "SELF" };
const THIRD: SubjectSpec = { kind: "fixed", subject: "THIRD_PARTY" };
const UNKNOWN_SUBJECT: SubjectSpec = { kind: "fixed", subject: "UNKNOWN" };
const INFER_SELF: SubjectSpec = { kind: "infer", fallback: "SELF" };
const INFER_UNKNOWN: SubjectSpec = { kind: "infer", fallback: "UNKNOWN" };

function rule(
  ruleId: string,
  opts: Partial<Omit<PhraseRuleSpec, "ruleId" | "patterns">> & Pick<PhraseRuleSpec, "baseStrength" | "subject">,
  patterns: readonly string[],
): PhraseRuleSpec {
  return {
    ruleId,
    source: opts.source ?? "EXPLICIT_PHRASE",
    baseStrength: opts.baseStrength,
    subject: opts.subject,
    defaultTemporal: opts.defaultTemporal ?? "CURRENT",
    upgradeOnRecency: opts.upgradeOnRecency ?? true,
    suppressWithAdminContext: opts.suppressWithAdminContext ?? false,
    patterns,
  };
}

const PILLS = "(pills|meds|medication|medications|medicine|tablets|sleeping pills)";
const ACCIDENTAL = "(?! (shaving|cooking|by accident|accidentally|at work|at the gym|playing|on (a|the|my)|falling|while|in the))";

// ---------------------------------------------------------------------------
// English (en-US)
// ---------------------------------------------------------------------------

const EN_RULES: readonly PhraseRuleSpec[] = [
  rule("explicit.en.self_kill", { baseStrength: "CREDIBLE", subject: SELF }, [
    "(kill|killing|killed|kills) myself",
    "(end|ending|ended|take|taking|took) my (own )?life",
    "(end|ending) it all",
    "(hang|hanging|hanged|shoot|shooting|drown|drowning) myself",
    "(jump|jumping) off (a|the) (bridge|building|roof)",
  ]),
  rule("explicit.en.suicide_term", { baseStrength: "CREDIBLE", subject: INFER_UNKNOWN }, [
    "suicidal( thoughts| feelings| ideation)?",
    "(commit|committing|committed|commits) suicide",
    "suicide(?! (hotline|hotlines|line|lifeline|prevention|crisis|awareness|squad|mission|watch))",
    "(thinking|thought|thoughts|think) (about|of) (suicide|dying)",
  ]),
  rule("explicit.en.self_harm", { baseStrength: "CREDIBLE", subject: SELF }, [
    `(hurt|hurting|harm|harming|cut|cutting|burn|burning|injure|injuring|starve|starving) myself${ACCIDENTAL}`,
  ]),
  rule("explicit.en.self_harm_term", { baseStrength: "CREDIBLE", subject: INFER_UNKNOWN }, [
    "self (harm|harming|harms|injury|injure|injuring|mutilation)",
  ]),
  rule("explicit.en.want_die", { baseStrength: "CREDIBLE", subject: INFER_SELF }, [
    "(want|wants|wanted|wanting|wanna|wish|wishes|wished|wishing) (to )?die",
    "(wish|wished|wishing) (i|he|she) (was|were|had) (dead|never been born)",
    "(better|be better) off dead",
    "(rather|prefer to) be dead",
    "(dont|do not|doesnt|does not|no longer) want to (live|be alive|exist|keep living)",
    "(dont|do not|doesnt|does not) want to wake up",
    "(tired|sick) of (living|being alive)",
    "(want|wants|ready) to stop living",
    "(feel|feeling|felt|feels) like (dying|i want to die|i should die|i should just die)",
    "(dont|do not|doesnt|does not) (want|wanna) to exist",
    "(want|wanna|wants) to (not exist|stop existing|not be alive)",
    "life (is not|isnt|aint|is no longer) worth living",
    "(cant|cannot|can not|dont think i can) keep (living|going on)",
  ]),
  rule("explicit.en.overdose", { baseStrength: "CREDIBLE", subject: INFER_SELF }, [
    "overdose|overdosed|overdoses|overdosing",
    `(take|taking|took|swallow|swallowing|swallowed) (all|a bottle|a whole bottle|a handful|a bunch|a lot|too many) (of )?(my |the |these |those |her |his |their )?${PILLS}`,
  ]),
  rule("explicit.en.past_attempt", { baseStrength: "UNRESOLVED", subject: INFER_SELF, defaultTemporal: "UNKNOWN" }, [
    "(tried|attempted|try|trying|attempt|attempting) (to )?(kill myself|commit suicide|end my life|take my (own )?life|overdose|suicide)",
    "suicide (attempt|attempts)",
  ]),
  rule("explicit.en.third_party_reflexive", { baseStrength: "CREDIBLE", subject: THIRD }, [
    "(kill|killing|killed|kills|hurt|hurting|hurts|harm|harming|harms|cut|cutting|cuts|hang|hanging) (himself|herself|themselves|themself)",
    "(end|ending|ended|take|taking|took) (his|her|their) (own )?life",
  ]),
  rule("indirect.en.burden_self", { baseStrength: "UNRESOLVED", subject: SELF }, [
    "better off without me",
    "(no one|nobody|noone) (would|will) (even )?(miss me|notice if i|care if i|notice i)",
    "(im|i am) (just )?a burden",
    "(no one|nobody|noone) (cares|would care|will care|even cares) (about me|if i)",
  ]),
  rule("indirect.en.burden_third_party", { baseStrength: "UNRESOLVED", subject: THIRD }, [
    "better off without (him|her|them)",
    "(no one|nobody) would (even )?(miss|notice) (him|her|them)",
  ]),
  rule("indirect.en.no_reason_to_live", { baseStrength: "UNRESOLVED", subject: INFER_SELF }, [
    "(no|not any|zero) (reason|reasons) (left )?to (live|go on|keep going|keep living)",
    "nothing (left )?to live for",
    "(no|whats the|what is the|not any) point (in|of|to) (living|life|being alive|going on|staying alive)",
    "(go to sleep|fall asleep|sleep) and (never|not) wake up",
    "(think|thinking|thought) about not (waking up|being here|being alive|existing)",
    "(saying|say|said) goodbye (to everyone|to everybody|for good|forever)",
    "(giving|gave|give) away (all )?(of )?my (things|stuff|belongings)",
    "(wrote|writing|written|write) (a|my) (goodbye |suicide )?(note|letter) (to|for) (my family|everyone|my kids)",
    "(wont|will not|not going to) be (around|here) (much longer|for long|anymore|tomorrow)",
  ]),
  rule("indirect.en.plan", { baseStrength: "CREDIBLE", subject: SELF }, [
    "(have|got|made|making|have got) (a|the) plan to (end it|end my life|kill myself|die|do it|end things)",
  ]),
  rule("indirect.en.ambiguous_end", { baseStrength: "UNRESOLVED", subject: INFER_SELF, suppressWithAdminContext: true }, [
    "(cant|can not|cannot) (go on|keep going|keep living)",
    "(want|wanna|going|gonna|plan|planning|ready) to end (it|things|everything)",
    "(want|wanna) to disappear",
    "(dont|do not) want to be here (anymore|any more)",
    "(thinking|think|thought) (of|about) ending (it|things|everything)",
    "(going|gonna) to jump(?! (on|in|into|ahead|to|through|back|the|a))",
  ]),
  rule("threat.en.harmed_by_other", { baseStrength: "CREDIBLE", subject: SELF }, [
    "(he|she|they|someone|somebody|my <w>) (is |s |are |re |was |keeps |kept |has been |have been |is going to |s going to |are going to |re going to |threatened to |threatens to |wants to |tried to |said (he|she|they) (would|will|is going to|was going to) )(kill|killing|kills|hurt|hurting|hurts|beat|beating|hit|hitting|choke|choking|stab|stabbing|shoot|shooting) me",
    "(threatened|threatening|threatens) to (kill|hurt) me",
    "(he|she|they|my <w>) (hits|beats|hurts|chokes|kicks|abuses|is abusing|keeps hitting|has been hitting|has been hurting) me",
    "(im|i am) (afraid|scared) (he|she|they) (will|is going to|s going to|might) (kill|hurt) me",
  ]),
  rule("indirect.en.unsafe", { baseStrength: "UNRESOLVED", subject: SELF, suppressWithAdminContext: true }, [
    "(dont|do not) feel safe",
    "(im|i am) not safe",
  ]),
  rule("threat.en.harm_to_other", { baseStrength: "UNRESOLVED", subject: THIRD }, [
    "(going to|gonna|want to|wanna|plan to|planning to) (kill|hurt|shoot|stab) (him|her|them|someone|somebody|everyone|people|my <w>)",
  ]),
  rule("request.en.crisis_line", { source: "CALLER_REQUEST", baseStrength: "UNRESOLVED", subject: UNKNOWN_SUBJECT, upgradeOnRecency: false }, [
    "(crisis|suicide|suicide prevention|mental health crisis) (line|hotline|lifeline|number|counselor|counselors|team|center|services)",
    "(call|calling|dial|dialing|text|texting|reach|number for|connect me to|transfer me to)( <w>){0,2} (988|nine eight eight)",
    "(988|nine eight eight) (line|lifeline|hotline|number)",
  ]),
  rule(
    "request.en.clinician_now",
    { source: "CALLER_REQUEST", baseStrength: "UNRESOLVED", subject: UNKNOWN_SUBJECT, upgradeOnRecency: false, suppressWithAdminContext: true },
    [
      "(talk|speak|speaking|talking) (to|with) ((a|an|the|my|someone|somebody|some) )?((crisis|mental health|real) )?(counselor|counsellor|clinician|therapist|psychiatrist|psychologist|social worker|mental health professional|nurse|doctor)",
      "connect me (to|with) ((a|an|my) )?((crisis) )?(counselor|counsellor|clinician|therapist|psychiatrist|psychologist)",
      "need (a|my|to see a|to see my) (therapist|counselor|counsellor|clinician|psychiatrist|psychologist) (right now|now|urgently|asap|today|immediately)",
    ],
  ),
];

// ---------------------------------------------------------------------------
// Spanish (es-US)
// ---------------------------------------------------------------------------

const ES_PILLS = "(pastillas|pildoras|medicinas|medicamentos|tabletas)";

const ES_RULES: readonly PhraseRuleSpec[] = [
  rule("explicit.es.self_kill", { baseStrength: "CREDIBLE", subject: SELF }, [
    "matarme",
    "me (quiero|voy a|pienso|podria|quisiera|deberia) matar",
    "me mataria",
    "quitarme la vida",
    "me (quiero|voy a|pienso) quitar la vida",
    "me quitaria la vida",
    "suicidarme",
    "me (quiero|voy a|pienso) suicidar",
    "me suicidaria",
    "(acabar|terminar) con mi vida",
    "ahorcarme|tirarme de un puente",
  ]),
  rule("explicit.es.suicide_term", { baseStrength: "CREDIBLE", subject: INFER_UNKNOWN }, [
    "(?<!prevencion del )(?<!prevencion de )suicidio",
    "suicida|suicidas",
  ]),
  rule("explicit.es.self_harm", { baseStrength: "CREDIBLE", subject: SELF }, [
    "hacerme dano(?! en)",
    "me (hago|hice|haria|voy a hacer|quiero hacer|he estado haciendo|estoy haciendo|sigo haciendo) dano(?! en)",
    "haciendome dano",
    "lastimarme(?! (la|el|los|las|mi) )",
    "me (lastimaria|voy a lastimar|quiero lastimar)",
    "cortarme(?! (el|la|las|los|mi))",
    "cortarme (los brazos|las munecas|la piel|las piernas|las venas)",
    "me (corto|cortaba|he cortado|estoy cortando) (los brazos|las munecas|la piel|las piernas|las venas)",
    "me (corto|cortaba|he cortado|estoy cortando)(?! (el|la|las|los|mi))",
    "autolesion|autolesiones|autolesionarme|autolesionando",
  ]),
  rule("explicit.es.want_die", { baseStrength: "CREDIBLE", subject: INFER_SELF }, [
    "(quiero|quisiera|queria|quise|deseo|deseaba|quiera) morir(me)?",
    "me (quiero|queria|quise) morir",
    "no quiero (seguir )?vivir",
    "no quiero seguir viviendo",
    "no quiero estar (vivo|viva)",
    "ojala (estuviera|estuviese) (muerto|muerta)",
    "(preferiria|prefiero) estar (muerto|muerta)",
    "(estaria|estoy) mejor (muerto|muerta)",
    "no quiero despertar(me)?",
    "(cansado|cansada) de vivir",
    "(siento|tengo) ganas de morir(me)?",
    "la vida no vale la pena",
  ]),
  rule("explicit.es.overdose", { baseStrength: "CREDIBLE", subject: INFER_SELF }, [
    "sobredosis",
    `(tomarme|tomar|me tome|me voy a tomar|tome) (todas|un frasco de|un monton de|muchas) (las |mis )?${ES_PILLS}`,
  ]),
  rule("explicit.es.past_attempt", { baseStrength: "UNRESOLVED", subject: INFER_SELF, defaultTemporal: "UNKNOWN" }, [
    "(intente|intento|trate de|he intentado) (matarme|suicidarme|quitarme la vida)",
    "(intento|intentos) de suicidio",
  ]),
  rule("explicit.es.third_party", { baseStrength: "CREDIBLE", subject: THIRD }, [
    "matarse",
    "se (quiere|va a|piensa|podria) matar",
    "suicidarse",
    "se (quiere|va a|piensa) suicidar",
    "quitarse la vida",
    "se (quiere|va a|piensa) quitar la vida",
    "hacerse dano",
    "se (hace|hizo|quiere hacer|esta haciendo) dano(?! en)",
    "lastimarse(?! (la|el|los|las))",
    "se (corta|cortaba|esta cortando|ha cortado) (los brazos|las munecas|la piel|las piernas|las venas)",
    "(quiere|dice que quiere|dijo que quiere|habla de) morir(se)?",
    "se (quiere|queria) morir",
    "no quiere (seguir )?vivir",
    "(acabar|terminar) con su vida",
  ]),
  rule("indirect.es.burden", { baseStrength: "UNRESOLVED", subject: SELF }, [
    "(estarian|estaria|estarias|estaran|estara) (todos )?mejor sin mi",
    "(nadie|ninguno) me (extranaria|echaria de menos|va a extranar)",
    "a nadie le (importaria|importa) si (me muero|me muriera|desaparezco|ya no estoy|no estoy)",
    "no tengo (ninguna )?(razon|razones|motivo|motivos) para (vivir|seguir)",
    "no vale la pena (vivir|seguir viviendo)",
    "(dormirme|dormir) y no despertar",
    "ya no voy a estar (aqui|mucho tiempo)",
    "(despedirme|me despedi|me estoy despidiendo) de (todos|todo el mundo|mi familia)",
    "(regale|regalando|regalar|regalo) (todas )?mis cosas",
  ]),
  rule("indirect.es.plan", { baseStrength: "CREDIBLE", subject: SELF }, [
    "tengo un plan para (matarme|morir|acabar con todo|quitarme la vida|suicidarme)",
  ]),
  rule("indirect.es.ambiguous_end", { baseStrength: "UNRESOLVED", subject: INFER_SELF, suppressWithAdminContext: true }, [
    "acabar con todo(?! (este|esta|esto|eso|el|la|los|las))",
    "quiero desaparecer",
    "ya no quiero (estar aqui|seguir)(?! (esperando|con|en|pagando|llamando))",
    "no puedo seguir (asi|viviendo)",
    "no vale la pena seguir(?! (esperando|con|en|llamando|pagando|intentando))",
    "(quisiera|me gustaria) desaparecer",
  ]),
  rule("threat.es.harmed_by_other", { baseStrength: "CREDIBLE", subject: SELF }, [
    "me (quiere|va a|amenazo con|amenaza con|trato de|intento) (matar|lastimar|pegar|golpear|hacer dano)",
    "me (amenazo|amenaza|amenazaba) con (matarme|lastimarme|pegarme|golpearme|hacerme dano)",
    "(quiere|va a|amenazo con|trato de|intento) (matarme|lastimarme|golpearme)",
    "me (esta|estan|sigue) (pegando|golpeando|lastimando|amenazando)",
    "mi <w> me (pega|golpea|lastima|amenaza)",
  ]),
  rule("indirect.es.unsafe", { baseStrength: "UNRESOLVED", subject: SELF, suppressWithAdminContext: true }, [
    "no me siento (segura|seguro|a salvo)",
    "no estoy (segura|seguro|a salvo) en (mi )?casa",
  ]),
  rule("threat.es.harm_to_other", { baseStrength: "UNRESOLVED", subject: THIRD }, [
    "(voy a|quiero|pienso) (matar|lastimar) (a|al) <w>",
    "(voy a|quiero) (matarlo|matarla|matarlos|lastimarlo|lastimarla)",
  ]),
  rule("request.es.crisis_line", { source: "CALLER_REQUEST", baseStrength: "UNRESOLVED", subject: UNKNOWN_SUBJECT, upgradeOnRecency: false }, [
    "linea (de crisis|de prevencion del suicidio|de ayuda para crisis|988)",
    "(llamar|marcar|comunicarme con|comunicar con) (al |a la )?(988|nueve ocho ocho)",
    "(consejero|consejera|equipo) de crisis",
  ]),
  rule(
    "request.es.clinician_now",
    { source: "CALLER_REQUEST", baseStrength: "UNRESOLVED", subject: UNKNOWN_SUBJECT, upgradeOnRecency: false, suppressWithAdminContext: true },
    [
      "(hablar|comunicarme|comunicar|hable|hablando) con ((un|una|mi|el|la|alguien|algun) )?((de )?salud mental )?(consejero|consejera|terapeuta|psicologo|psicologa|psiquiatra|medico|medica|doctor|doctora|clinico|clinica|enfermero|enfermera|profesional de salud mental)",
      "necesito (un|una|a mi|mi) (terapeuta|psicologo|psicologa|psiquiatra|consejero|consejera) (ahora|ya|urgente|de inmediato)",
    ],
  ),
];

export const PHRASE_RULES: readonly PhraseRuleSpec[] = [...EN_RULES, ...ES_RULES];

// ---------------------------------------------------------------------------
// Idioms (masked before any rule runs) — ambiguous hyperbole is not a signal
// ---------------------------------------------------------------------------

const THING =
  "(bill|bills|invoice|charge|charges|fee|fees|wait|waiting|hold|music|line|queue|process|system|app|website|portal|phone|menu|paperwork|insurance|claim|copay|price|prices|cost|costs|traffic|back|head|feet|knees|neck|job|work|commute|heat|rent|this|that|it|its|thats|these|those|you|youre|ya)";

export const IDIOM_PATTERNS: readonly string[] = [
  `${THING}( <w>){0,2} (is|are|s|re|was|were|keeps|kept|has been|have been)( really| literally| just| seriously| absolutely| totally)? killing me`,
  "(youre|you are|you guys are|ya|ur) (really |literally |just |seriously |totally )?killing me",
  "(die|dying|died) (of|from) (embarrassment|shame|laughter|laughing|boredom|hunger|thirst|curiosity|old age|cuteness)",
  "(die|died|dying) laughing",
  "dying (to|for) <w>",
  "dead (tired|serious|set|end|on my feet|beat|broke|wrong|last)",
  "(phone|battery|cell|laptop|computer|car|tablet|headset|connection) (is |was |s |just |keeps |is about to |is going to |is gonna |about to |going to |gonna )*(dead|die|died|dying)",
  "(bored|scared|worried|sick|frightened|tickled) to death",
  "(be|is|was|will be) the death of me",
  "(is|was|are|were|looks|look|tastes|taste|sounds) to die for",
  "over my dead body",
  "(kill|killing|killed) (time|it|two birds)",
  "(would|could) kill for (a|an|some|the) <w>",
  "(almost|nearly) (died|had a heart attack|passed out) when (i|we) (saw|got|opened|read|heard|looked)",
  "drop dead gorgeous",
  "(rather|prefer to) die than( <w>){0,2} (wait|waiting|call|calling|deal|pay|sit|go through|be on hold|talk to|use)",
  // es
  "(muero|muriendo|mori|morir|morirme|morirse|muere) de (verguenza|risa|hambre|sed|sueno|frio|calor|aburrimiento|ganas|curiosidad|miedo|nervios)",
  "me muero por <w>",
  "(muerto|muerta|muertos|muertas) de (cansancio|sueno|risa|hambre|miedo|frio|calor|verguenza|aburrimiento)",
  "(factura|facturas|cuenta|cuentas|espera|cobro|cobros|pago|pagos|trabajo|espalda|cabeza|pies|musica|esto|eso|sistema|llamada|linea|precio|precios|renta|seguro|papeleo|tramite|tramites)( <w>){0,2} me (esta |estan |va a |van a )?(matando|matar|mata|matan)",
  "me (mata|matan|esta matando|estan matando) (la|el|esta|este|esa|ese|tanta|tanto|los|las) (espera|musica|factura|cuenta|cobro|cobros|burocracia|sistema|trafico|calor|papeleo|cabeza|espalda)",
  "(me|nos) (vas|va) a matar de <w>",
  "matar el tiempo",
  "(telefono|celular|bateria|computadora|carro) (se |ya |esta |se esta |se me )*(murio|muerto|muerta|muriendo)",
];

// ---------------------------------------------------------------------------
// Context cues
// ---------------------------------------------------------------------------

/** Single-token negation cues looked up within NEGATION_WINDOW tokens before a match. */
export const NEGATION_TOKENS: ReadonlySet<string> = new Set([
  "not", "never", "dont", "doesnt", "didnt", "wont", "wouldnt", "isnt", "arent", "wasnt", "werent", "shouldnt", "nor", "no",
  "nunca", "jamas", "tampoco", "ni",
]);
/** "no" followed by one of these is not a negation of the act ("no one", "no longer", "no way"). */
export const NEGATION_NO_EXCEPTIONS: ReadonlySet<string> = new Set(["one", "longer", "way", "matter"]);
export const NEGATION_WINDOW = 5;

export const THIRD_PARTY_TOKENS: ReadonlySet<string> = new Set([
  "he", "she", "they", "him", "her", "them", "his", "hers", "their", "hes", "shes", "theyre",
  "friend", "friends", "son", "sons", "daughter", "daughters", "kid", "kids", "child", "children", "brother", "sister", "mom",
  "mother", "dad", "father", "husband", "wife", "partner", "boyfriend", "girlfriend", "roommate", "cousin", "aunt", "uncle",
  "grandma", "grandmother", "grandpa", "grandfather", "nephew", "niece", "coworker", "colleague", "neighbor", "client",
  "patient", "student", "teen", "teenager", "fiance", "fiancee", "spouse", "stepson", "stepdaughter",
  "ella", "ellos", "ellas", "hijo", "hija", "hijos", "hijas", "amigo", "amiga", "hermano", "hermana", "esposo", "esposa",
  "marido", "pareja", "novio", "novia", "mama", "papa", "madre", "padre", "primo", "prima", "companero", "companera",
  "vecino", "vecina", "paciente", "abuela", "abuelo", "tio", "tia", "sobrino", "sobrina",
]);

export const FIRST_PERSON_TOKENS: ReadonlySet<string> = new Set([
  "i", "im", "ive", "id", "ill", "me", "my", "myself", "mine", "yo", "estoy", "quiero", "siento", "tengo", "pienso",
]);

/** Explicit recency cues (same clause) => CURRENT; they override historical cues. */
export const RECENCY_PATTERNS: readonly string[] = [
  "now|right now|tonight|today|currently|lately|recently|still|again|anymore|any more|these days",
  "last night|this morning|this afternoon|this evening|this week|yesterday",
  "ahora|ahorita|hoy|esta noche|anoche|ayer|esta manana|esta semana|otra vez|de nuevo|todavia|aun|ultimamente|recientemente",
];

/** Historical cues (same sentence) => HISTORICAL when no recency cue is in the clause. */
export const HISTORICAL_PATTERNS: readonly string[] = [
  "(<w> )?(years|year|months|decades) ago|a long time ago|long ago|in the past|used to|back then|back in <w>",
  "when i was( <w>){0,3} (kid|teen|teenager|younger|young|child|little|in high school|in college|in middle school)",
  "when i was (a kid|a teen|a teenager|younger|young|a child|little)",
  "as a (kid|teen|teenager|child)|in high school|in college|in middle school|last year|(a few )?years back|in my (twenties|teens|thirties)",
  "hace( <w>)? (anos|ano|meses|mucho|tiempo)|el ano pasado|cuando era( <w>){0,2} (joven|nino|nina|adolescente|chico|chica)",
  "de (joven|adolescente|nino|nina)|en el pasado|solia|en la (secundaria|prepa|preparatoria|universidad)|antes(?! (de|que))",
];

/** Administrative objects: ambiguous distress phrases about these are treated as frustration. */
export const ADMIN_CONTEXT_TOKENS: ReadonlySet<string> = new Set([
  "bill", "bills", "billing", "billed", "invoice", "invoices", "charge", "charges", "charged", "payment", "payments", "pay",
  "paying", "paid", "insurance", "insurer", "claim", "claims", "refund", "fee", "fees", "copay", "portal", "website", "site",
  "app", "application", "login", "password", "account", "hold", "wait", "waiting", "waited", "queue", "phone", "menu", "line",
  "transfer", "transferred", "call", "calling", "calls", "called", "appointment", "appointments", "schedule", "scheduling",
  "reschedule", "rescheduling", "system", "automated", "robot", "machine", "bot", "form", "forms", "paperwork", "card",
  "company", "service", "subscription", "support", "agent", "representative", "music", "link", "email", "text", "message",
  "factura", "facturas", "facturacion", "cuenta", "cobro", "cobros", "cobraron", "cargo", "cargos", "pago", "pagos", "pagar",
  "seguro", "aseguradora", "reclamo", "reclamacion", "reembolso", "sitio", "pagina", "aplicacion", "contrasena", "usuario",
  "espera", "esperar", "esperando", "llamada", "llamar", "llamando", "linea", "cita", "citas", "reprogramar", "sistema",
  "maquina", "formulario", "papeleo", "tarjeta", "compania", "empresa", "servicio", "musica", "enlace", "correo", "mensaje",
  "transferencia", "transfirieron",
]);

// ---------------------------------------------------------------------------
// Partial risk lexemes (ASR-uncertain and unsupported-locale screens)
// ---------------------------------------------------------------------------

export const PARTIAL_RISK_PATTERNS: readonly string[] = [
  "kill[a-z]*|die|dies|dying|died|dead|death|suicid[a-z]*|overdos[a-z]*|self harm|end (it|my life)|(hurt|harm|cut|hang) myself",
  "matar[a-z]*|morir[a-z]*|muero|muerte|muerto|muerta|suicid[a-z]*|lastimar[a-z]*|dano|sobredosis|cortarme|quitarme la vida",
];

/**
 * Multilingual lexeme screen for unsupported locales (script-preserving
 * normalization). LOCAL DRAFT: a short, unreviewed list; BLOCKED pending
 * language leads' reviewed lexicons. "word" entries match at a word start;
 * "substring" entries are for scripts written without spaces.
 */
export const MULTILINGUAL_LEXEMES: readonly { lexeme: string; mode: "word" | "substring" }[] = [
  // fr
  { lexeme: "suicid", mode: "word" }, { lexeme: "me tuer", mode: "word" }, { lexeme: "mourir", mode: "word" },
  // pt
  { lexeme: "me matar", mode: "word" }, { lexeme: "morrer", mode: "word" }, { lexeme: "suicídio", mode: "word" },
  // de
  { lexeme: "selbstmord", mode: "word" }, { lexeme: "suizid", mode: "word" }, { lexeme: "umbringen", mode: "word" }, { lexeme: "sterben", mode: "word" },
  // it
  { lexeme: "uccidermi", mode: "word" }, { lexeme: "ammazzarmi", mode: "word" }, { lexeme: "morire", mode: "word" },
  // tl
  { lexeme: "magpakamatay", mode: "word" }, { lexeme: "mamatay", mode: "word" },
  // ht
  { lexeme: "touye tèt mwen", mode: "word" },
  // pl
  { lexeme: "samobój", mode: "word" },
  // ru
  { lexeme: "суицид", mode: "word" }, { lexeme: "убить себя", mode: "word" }, { lexeme: "покончить с собой", mode: "word" }, { lexeme: "умереть", mode: "word" },
  // zh / ja / ko / ar / hi (no reliable word spacing => substring)
  { lexeme: "自杀", mode: "substring" }, { lexeme: "自殺", mode: "substring" }, { lexeme: "想死", mode: "substring" }, { lexeme: "不想活", mode: "substring" },
  { lexeme: "死にたい", mode: "substring" }, { lexeme: "자살", mode: "substring" }, { lexeme: "죽고 싶", mode: "substring" },
  { lexeme: "انتحار", mode: "substring" }, { lexeme: "आत्महत्या", mode: "substring" },
];

// ---------------------------------------------------------------------------
// Local heuristic "semantic" distress cues (see detector.ts)
// ---------------------------------------------------------------------------

export const DISTRESS_PATTERNS: readonly string[] = [
  "(cant|can not|cannot) (take|stand|handle|deal with) (it|this|that|anything|any of this)( <w>){0,4} (anymore|any more)",
  "(cant|can not|cannot) do this (anymore|any more)",
  "(whats|what is) the point",
  "(theres|there is) no point",
  "(feel|feeling|im|i am|so|completely|totally) hopeless",
  "(no|dont see a|dont see any|cant see a|cant see any) way out",
  "(want|wish) (it|everything) (all )?to (stop|end|go away)",
  "(done|finished) with (everything|it all|life)",
  "(tired|exhausted) of (everything|it all)",
  "at the end of my rope",
  "(i )?(just )?give up",
  "nothing matters",
  "(everything|life) is (too much|falling apart)",
  // es
  "no (aguanto|soporto)( mas| ya)?",
  "ya no (puedo|aguanto|soporto)",
  "no puedo mas",
  "(no tiene|nada tiene) sentido",
  "para que seguir",
  "(me siento|estoy|siento) (sin esperanza|desesperado|desesperada|vacio|vacia)",
  "no (hay|veo) (ninguna )?salida",
  "quiero que todo (pare|termine|se acabe)",
  "(harto|harta) de todo",
  "me rindo",
];

/** Every rule id the detectors can emit (for validation and DB constraints). */
export const DETECTOR_RULE_IDS = {
  asrLowConfidence: "asr.low_confidence.risk_lexeme",
  unsupportedLocale: "locale.unsupported.risk_lexeme",
  semanticDistress: "semantic.local.distress_without_admin_context",
  semanticUnavailable: "semantic.unavailable.risk_lexeme",
  humanIntervention: "human.intervention.flagged",
  inputInvalid: "input.invalid.fail_safe",
  inputOversize: "input.oversize.fail_safe",
  signalMalformed: "signal.malformed.fail_safe",
  stageFailed: "rules.stage_failed.fail_safe",
} as const;

export const ALL_RULE_IDS: ReadonlySet<string> = new Set([...PHRASE_RULES.map((r) => r.ruleId), ...Object.values(DETECTOR_RULE_IDS)]);
