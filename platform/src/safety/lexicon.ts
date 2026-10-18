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
 * Every phrase family below was written by the coding agent from synthetic
 * examples (including the families added after the local corpus run found
 * recall gaps: passive ideation behind a negated frame, unspecified past
 * attempts, third-party farewell and "not being around" warnings, and their
 * Spanish counterparts). None of it is clinically reviewed; widening it is not
 * evidence of completeness. Clinical safety lead review (PRQ-008) and a
 * reviewed, native-speaker-checked corpus (PRQ-012) are still required before
 * any patient-facing use.
 *
 * Rule ids are stable audit codes. Changing a pattern keeps the id; adding a
 * behaviourally new rule gets a new id; LEXICON_VERSION changes on any edit.
 *
 * Phrase grammar: see compilePhrase() in text.ts (a space = word boundary that
 * may cross a clause comma; `<w>` = one word). Sources are written against the
 * normalized form: lower case, no accents, no apostrophes.
 */
import type { SafetySignal } from "./ports.js";

export const LEXICON_VERSION = "safety-lexicon.2026-10-18.draft.3";
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
const ACCIDENTAL = "(?! (shaving|cooking|by accident|accidentally|at work|at the gym|playing|on (a|the|my)|falling|while|in the)(?![a-z0-9]))";

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
    "suicide(?! (hotline|hotlines|line|lifeline|prevention|crisis|awareness|squad|mission|watch)(?![a-z0-9]))",
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
    "(dont|do not|doesnt|does not) (want to|wanna) exist",
    "(want to|wanna|wants to) (not exist|stop existing|not be alive)",
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
    "(attempt|attempts|attempted) on (my|his|her|their) (own )?life",
  ]),
  // A past attempt referred to without naming it ("I attempted a few days ago", "hospitalized after
  // an attempt"). Intransitive "attempted" only (an object such as "to log in" or "the payment" never
  // matches) and suppressed when the sentence is about an administrative object.
  rule("indirect.en.attempt_unspecified", { baseStrength: "UNRESOLVED", subject: INFER_SELF, defaultTemporal: "UNKNOWN", suppressWithAdminContext: true }, [
    "(?<=(i|ive|id|he|hes|she|shes|they|theyve|theyd|has|have|had|already|previously|once|actually|also|nearly|almost) )attempted(?=$| ,| (a few|a couple|a week|a month|a year|last|yesterday|today|tonight|recently|again|before|earlier|twice|once|this|on|in|over|and|but|so|when|after|because|years|months|weeks|days|while)(?![a-z0-9]))",
    "(made|make|making|makes|had|have|has) (an|a|another|a second|a third|one) attempt(?! (to|at|on (the|a|an|your|our|this|that|it)|of|for|with|by|in)(?![a-z0-9]))",
    "(hospitalized|hospitalised|admitted|survived|recovering|recovered|in the hospital|in hospital|in the er|in the emergency room)( (after|from|following|because of|for))? (an|a|my|his|her|their|the|another) attempt(?! (to|at|of|for|with|by|in)(?![a-z0-9]))",
  ]),
  // Researching a method is plan-like risk content even when an earlier clause is negated
  // ("I don't think I'm suicidal, but I've been looking up ways to die").
  rule("indirect.en.method_research", { baseStrength: "CREDIBLE", subject: INFER_SELF }, [
    "(looking up|looked up|look up|looks up|searching|searched|search|searches|googling|googled|google|researching|researched|research|reading about|read about) (ways|how|methods|the best way|the easiest way|an easy way|a painless way|painless ways) to (die|kill (myself|himself|herself|themselves)|end (my|his|her|their) life|end it all|overdose|commit suicide)",
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
    "(giving|gave|give|given|gives) away (all )?(of )?(my|his|her|their) (things|stuff|belongings|possessions)",
    "(giving|gave|give|given|gives) (all )?(of )?(my|his|her|their) (things|stuff|belongings|possessions) away",
    "(wrote|writing|written|write) (a|my) (goodbye |suicide )?(note|letter) (to|for) (my family|everyone|my kids)",
    "(wont|will not|not going to) be (around|here) (much longer|for long|anymore|tomorrow)",
  ]),
  rule("indirect.en.plan", { baseStrength: "CREDIBLE", subject: SELF }, [
    "(have|got|made|making|have got) (a|the) plan to (end it|end my life|kill myself|die|do it|end things)",
  ]),
  // Passive ideation. The negation inside these phrases ("wouldn't wake up", "wasn't here") IS the risk
  // content, so it is part of the match and never marks the signal negated; a negated frame in an
  // earlier clause ("I'm not saying I'd do anything, but ...") does not reach it either.
  rule("indirect.en.passive_ideation", { baseStrength: "UNRESOLVED", subject: INFER_SELF }, [
    "(wish|wished|wishing|hope|hoped|hoping|pray|prayed|praying) (that )?(i|id) (wouldnt|would not|didnt|did not|couldnt|could not|wont|will not|dont|do not|never|would never|would just not|could just not) (wake|woke)( up)?(?! (up|late|early|in time|on time|too|so|before|at|for|to|from|in the|with)(?![a-z0-9]))",
    "(wish|wished|wishing) (that )?(i|id) (could|would) (just )?(not|never) wake( up)?(?! (up|late|early|in time|on time|too|so|before|at|for|to|from|in the|with)(?![a-z0-9]))",
    "(wish|wished|wishing) (that )?(i|id) (could|would) (just )?(sleep forever|go to sleep forever|fall asleep forever|stop existing|not exist|disappear forever)",
    "(wish|wished|wishing) (that )?(i|id) (was|were|had) (gone|not here|not around|not alive|never born|never existed)",
    "(wouldnt|would not) (mind|care) (if i )?(not waking up|dying|died|didnt wake up|did not wake up|never woke up|not being here|not being alive|being dead)",
    "(easier|better) (for (everyone|everybody|my family|my kids|them|all of them) )?if i (just )?(wasnt|werent|was not|were not) (even )?(here|around|alive|born)(?=$| ,| (anymore|any more|at all|for good|anyway|honestly)(?![a-z0-9]))",
    "(easier|better) (for (everyone|everybody|my family|my kids|them|all of them) )?if i (just )?(died|disappeared|was gone|were gone|didnt exist|did not exist|never woke up|didnt wake up|did not wake up)",
  ]),
  // Doubt about wanting to live: the negation scopes over certainty, not over the risk content.
  rule("indirect.en.ambivalence_living", { baseStrength: "UNRESOLVED", subject: INFER_SELF }, [
    "(not sure|unsure|dont know|do not know|dont even know|not certain) (if |whether |that )?(i|id) (still |even )?(want to|wanna|would want to) (live|be alive|keep living|go on living|go on|be here|exist|wake up)(?! (in|with|near|there|here|alone|on|at|close|closer|by|together|for|during|when|while|next|this|tomorrow|today|until)(?![a-z0-9]))",
  ]),
  // Someone (often a third party) talking about not being around, or saying goodbye.
  rule("indirect.en.not_being_around", { baseStrength: "UNRESOLVED", subject: INFER_SELF }, [
    "(talking|talks|talked|talk|joking|jokes|joked|joke) about not (being|be) (around|here|alive)(?! (for|at|on|during|when|while|next|this|tomorrow|today|until|in the)(?![a-z0-9]))",
    "(talking|talks|talked|talk|joking|jokes|joked|joke) about (dying|suicide|ending it|ending it all|ending (his|her|their|my) life|not waking up)",
    "(not|wont|will not|isnt going to|is not going to|arent going to|are not going to) (be|being) (around|here) (much longer|for much longer|for long|anymore|any more)",
  ]),
  rule("indirect.en.farewell", { baseStrength: "UNRESOLVED", subject: INFER_SELF }, [
    "(posting|posted|posts|post|writing|wrote|written|writes|write|sending|sent|sends|send|texting|texted|texts|leaving|left|leaves|recording|recorded) (a |some |these |those |his |her |their |my )?(goodbye|goodbyes) (messages|message|notes|note|letters|letter|posts|post|texts|text|videos|video|emails|email)",
    "(saying|said|says|say) (goodbye|goodbyes) to (people|everyone|everybody|all (of )?(his|her|their|my) (friends|family)|(his|her|their) (friends|family|kids|children|loved ones))",
    "(saying|said|says|say) (his|her|their|my) (goodbyes|last goodbyes|final goodbyes)",
  ]),
  // Recurrence of unnamed thoughts after an unnamed event. Ambiguous on its own: suppressed with an
  // administrative object and never upgraded by a recency cue. A bare "thinking about it again" is NOT
  // a rule (too generic; see the negative corpus cases).
  rule("indirect.en.recurrence", { baseStrength: "UNRESOLVED", subject: INFER_SELF, upgradeOnRecency: false, suppressWithAdminContext: true }, [
    "(the|those|these|my|dark|bad) (thoughts|urges) (are|have|came|come|keep coming|started coming) (back|coming back|returned)",
    "(having|had|have|getting|get|got) (the|those|these|dark|bad) (thoughts|urges) again",
    "(after|since) what happened( <w>){0,6} (thinking|think|thought) about (it|doing it) again",
  ]),
  rule("indirect.en.ambiguous_end", { baseStrength: "UNRESOLVED", subject: INFER_SELF, suppressWithAdminContext: true }, [
    "(cant|can not|cannot) (go on|keep going|keep living)",
    "(want to|wanna|going to|gonna|plan to|planning to|ready to) end (it|things|everything)",
    "(want to|wanna) disappear",
    "(dont|do not) want to be here (anymore|any more)",
    "(thinking|think|thought) (of|about) ending (it|things|everything)",
    "(going to|gonna) jump(?! (on|in|into|ahead|to|through|back|the|a|ship|up|start|right|at the (chance|opportunity|offer))(?![a-z0-9]))",
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
    "hacerme dano(?! en(?![a-z0-9]))",
    "me (hago|hice|haria|voy a hacer|quiero hacer|he estado haciendo|estoy haciendo|sigo haciendo) dano(?! en(?![a-z0-9]))",
    "haciendome dano",
    "lastimarme(?! (la|el|los|las|mi) )",
    "me (lastimaria|voy a lastimar|quiero lastimar)",
    "cortarme(?! (el|la|las|los|mi|mis|tu|tus|su|sus)(?![a-z0-9]))",
    "cortarme (los brazos|las munecas|la piel|las piernas|las venas)",
    "me (corto|cortaba|he cortado|estoy cortando) (los brazos|las munecas|la piel|las piernas|las venas)",
    "me (corto|cortaba|he cortado|estoy cortando)(?! (el|la|las|los|mi|mis|tu|tus|su|sus)(?![a-z0-9]))",
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
    `(tomarme|tomar|me tome|me voy a tomar|tome|se tomo|se tome|se va a tomar) (todas|un frasco de|un frasco entero de|un monton de|muchas|demasiadas|un punado de|una caja de) (las |mis |sus )?${ES_PILLS}`,
  ]),
  rule("explicit.es.past_attempt", { baseStrength: "UNRESOLVED", subject: INFER_SELF, defaultTemporal: "UNKNOWN" }, [
    "(intente|intento|trate de|he intentado) (matarme|suicidarme|quitarme la vida)",
    "(intento|intentos) de suicidio",
    "intento de (quitarme|quitarse) la vida",
  ]),
  // Counterpart of indirect.en.attempt_unspecified ("tuve un intento", "sobreviví a un intento").
  rule("indirect.es.attempt_unspecified", { baseStrength: "UNRESOLVED", subject: INFER_SELF, defaultTemporal: "UNKNOWN", suppressWithAdminContext: true }, [
    "(tuve|tuvo|he tenido|ha tenido|hice|hizo) (un|otro) intento(?! (de|por|para) (pago|pagar|cobro|inicio|iniciar|acceso|acceder|entrar|llamada|llamar|contacto|registro|conexion|conectar|sesion|cita)(?![a-z0-9]))",
    "(sobrevivi|sobrevivio|despues de|desde|tras) (a )?(un|el|mi|su|otro) intento(?! (de|por|para) (pago|pagar|cobro|inicio|iniciar|acceso|acceder|entrar|llamada|llamar|contacto|registro|conexion|conectar|sesion|cita)(?![a-z0-9]))",
    "(hospitalizado|hospitalizada|internado|internada|en urgencias|en el hospital) (por|despues de|tras) (un|el|mi|su) intento",
  ]),
  // Counterpart of indirect.en.passive_ideation / ambivalence_living (negation is part of the content).
  rule("indirect.es.passive_ideation", { baseStrength: "UNRESOLVED", subject: INFER_SELF }, [
    "ojala (ya )?no (despertara|despertase|me despertara|me despertase|amaneciera|amaneciese|existiera|hubiera nacido)(?! (tan|temprano|a las|antes|tarde)(?![a-z0-9]))",
    "(quisiera|me gustaria|preferiria|prefiero) (ya )?no (despertar|despertarme|existir|amanecer)(?! (tan|temprano|a las|antes|tarde)(?![a-z0-9]))",
    "(seria|todo seria|serian|seria todo) mas (facil|sencillo) (para todos )?si (yo )?(ya )?no (estuviera|existiera|despertara|estuviese)",
    "(estarian|estaria|estarias|estaran|todos estarian) mejor si (yo )?(ya )?no (estuviera|existiera|estuviese)",
    "no (se|estoy (seguro|segura) de) si (quiero|quisiera) seguir (viviendo|vivo|viva)",
    "no estoy (seguro|segura) de querer seguir (viviendo|vivo|viva)",
  ]),
  rule("indirect.es.no_point_living", { baseStrength: "UNRESOLVED", subject: INFER_SELF }, [
    "no (le )?(veo|encuentro) (ningun |el )?sentido (a|en) (seguir viviendo|seguir vivo|seguir viva|seguir adelante(?! con(?![a-z0-9]))|vivir|la vida|mi vida|estar vivo|estar viva)",
    "no (le )?(veo|encuentro) (ningun |el )?sentido (a|en) seguir(?=$| ,(?![a-z0-9]))",
    "(mi vida|la vida) (ya )?no tiene (ningun )?sentido",
  ]),
  // Counterparts of indirect.en.farewell / not_being_around (mostly third-party warnings).
  rule("indirect.es.farewell", { baseStrength: "UNRESOLVED", subject: INFER_SELF }, [
    "(publicando|publica|publico|publicado|escribiendo|escribe|escribio|escrito|mandando|manda|mando|enviando|envia|envio|dejo|dejando) (unos |unas |varios |varias |una |un )?(mensajes|mensaje|cartas|carta|notas|nota|publicaciones|videos|video) de despedida",
    "(se esta despidiendo|se despide|se despidio|despidiendose|se ha estado despidiendo) de (todos|todo el mundo|la gente|su familia|sus amigos|sus seres queridos)",
    "(habla|hablando|ha estado hablando|hablo|dice|dijo) (de|que) (ya )?no (va a estar|estara|estar|seguir) (aqui |vivo |viva )?(mucho tiempo|por mucho tiempo|mucho mas)",
    "(habla|hablando|ha estado hablando|hablo) de (ya )?no (estar|seguir) (aqui|vivo|viva)(?=$| ,(?![a-z0-9]))",
    "(regalando|regala|regalo|ha regalado) (todas )?sus cosas",
  ]),
  rule("indirect.es.recurrence", { baseStrength: "UNRESOLVED", subject: INFER_SELF, upgradeOnRecency: false, suppressWithAdminContext: true }, [
    "(volvi|he vuelto|estoy volviendo|vuelvo) a pensar en (hacerlo|hacerme dano|matarme|morirme)",
    "(volvieron|han vuelto|regresaron|han regresado) (los|esos|mis|estos) (pensamientos|impulsos)",
    "(tengo|tuve|estoy teniendo) (esos|estos|otra vez esos|esos malos|malos) (pensamientos|impulsos)",
  ]),
  rule("explicit.es.third_party", { baseStrength: "CREDIBLE", subject: THIRD }, [
    "matarse",
    "se (quiere|va a|piensa|podria) matar",
    "suicidarse",
    "se (quiere|va a|piensa) suicidar",
    "quitarse la vida",
    "se (quiere|va a|piensa) quitar la vida",
    "hacerse dano",
    "se (hace|hizo|quiere hacer|esta haciendo) dano(?! en(?![a-z0-9]))",
    "lastimarse(?! (la|el|los|las)(?![a-z0-9]))",
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
    "acabar con todo(?! (este|esta|esto|eso|estos|estas|esos|esas|el|la|lo|los|las)(?![a-z0-9]))",
    "quiero desaparecer",
    "ya no quiero (estar aqui|seguir)(?! (esperando|con|en|pagando|llamando)(?![a-z0-9]))",
    "no puedo seguir (asi|viviendo)",
    "no vale la pena seguir(?! (esperando|con|en|llamando|pagando|intentando)(?![a-z0-9]))",
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
/**
 * Negation scope: a negation cue does not reach across a coordinator that opens a new clause with its
 * own subject ("I don't sleep anymore and I want to die": the second clause is not negated). "or" /
 * "ni" are deliberately absent: "not going to hurt myself or kill myself" negates both.
 */
export const NEGATION_SCOPE_BREAKERS: ReadonlySet<string> = new Set(["and", "so", "because", "cause", "cuz", "then", "y", "e", "porque", "entonces", "pues"]);
/** A disjunction extends a negation's window over the next conjunct ("not going to hurt myself or kill myself"). */
export const NEGATION_DISJUNCTIONS: ReadonlySet<string> = new Set(["or", "nor", "o", "u", "ni"]);
/** Tokens that start a new clause's subject after a NEGATION_SCOPE_BREAKER (pronouns and es first-person verbs). */
export const CLAUSE_SUBJECT_TOKENS: ReadonlySet<string> = new Set([
  "i", "im", "ive", "id", "ill", "he", "she", "they", "hes", "shes", "theyre", "we", "yo", "ella", "ellos", "ellas",
  "estoy", "quiero", "siento", "tengo", "pienso",
]);

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
  "de (joven|adolescente|nino|nina)|en el pasado|solia|en la (secundaria|prepa|preparatoria|universidad)|antes(?! (de|del|que)(?![a-z0-9]))",
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
  "(ya )?no (le )?veo (el |ningun )?sentido a nada(?! de (esto|este|esta|eso|esa|ese|lo|la|el|los|las)(?![a-z0-9]))",
  "(cansado|cansada|agotado|agotada) de todo(?! (esto|este|esta|eso|el|la|lo|los|las)(?![a-z0-9]))",
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
