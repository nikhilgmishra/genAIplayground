/**
 * search_approved_runbook and get_login_guidance (public:read, login_help:read).
 * Knowledge excerpts are sanitized, approved and cited (exact version). They are
 * returned as data for grounded paraphrase; gate-rendered speech exists only where an
 * approved template covers the intent. Free model paraphrase of an excerpt is the
 * LOW_RISK_GROUNDED class, which the voice gate does not render (BLOCKED, voice README).
 */
import { z } from "zod";
import type { BusinessServices } from "../../business/services/types.js";
import { PUBLIC_FAQ_INTENTS } from "../../business/services/knowledge.js";
import { openResource } from "../../business/shared.js";
import { speechFor } from "../../business/speech.js";
import type { ToolSpeech } from "../../business/speech.js";
import type { KnowledgeHit } from "../../knowledge/ports.js";
import type { ToolModule } from "../ports.js";
import { LanguageArg, ok, retryable } from "./common.js";
import { TOOL_DEFINITIONS } from "./definitions.js";

/** Bounded keywords: letters, spaces and light punctuation only (no digits, so no numbers or dates). Never echoed. */
const QueryArg = z.string().min(2).max(160).regex(/^[\p{L}][\p{L} ,.'?¿¡!-]*$/u);

const Article = z.strictObject({
  citationId: z.string().regex(/^kb_[A-Za-z0-9_.-]{1,80}@v\d{1,6}$/),
  articleId: z.string().max(80),
  articleVersion: z.number().int().min(1),
  title: z.string().max(200),
  body: z.string().max(1200),
});

const toArticle = (h: KnowledgeHit): z.infer<typeof Article> => ({
  citationId: h.citationId,
  articleId: h.sourceId,
  articleVersion: h.version,
  title: h.title.slice(0, 200),
  body: h.excerpt.slice(0, 1200),
});

/** Intents whose answer has an approved deterministic template. */
const INTENT_TEMPLATES: Partial<Record<(typeof PUBLIC_FAQ_INTENTS)[number], string>> = {
  portal_login_help: "login.guidance",
  payment_help: "billing.payment_page",
  human_request: "human.offer",
};

export const SearchInput = z.strictObject({
  intent: z.enum(PUBLIC_FAQ_INTENTS),
  query: QueryArg.nullable(),
  language: LanguageArg,
});
export const SearchOutput = z.strictObject({
  articles: z.array(Article).max(5),
  intent: z.enum(PUBLIC_FAQ_INTENTS),
  resultCount: z.number().int().min(0).max(5),
});

export function searchApprovedRunbookTool(s: BusinessServices): ToolModule<z.infer<typeof SearchInput>, z.infer<typeof SearchOutput>> {
  return {
    definition: TOOL_DEFINITIONS.search_approved_runbook,
    maskTarget: { collectionKey: "articles", envelopeKeys: ["intent", "resultCount"] },
    input: SearchInput,
    output: SearchOutput,
    purpose: () => "public_information",
    resolveResource: async (auth) => openResource(auth, "knowledge_article", "PUBLIC"),
    async execute(ctx, input) {
      let hits: KnowledgeHit[];
      try {
        hits = await s.knowledge.search(ctx.auth, { intent: input.intent, query: input.query, language: input.language.split("-")[0] ?? "en", limit: 3 });
      } catch {
        return retryable("KNOWLEDGE_UNAVAILABLE");
      }
      const articles = hits.slice(0, 3).map(toArticle);
      const templateId = INTENT_TEMPLATES[input.intent];
      const speech: ToolSpeech | null =
        articles.length === 0 ? speechFor(s.deps.templates, "knowledge.no_answer") : templateId ? speechFor(s.deps.templates, templateId, {}, articles.map((a) => a.citationId)) : null;
      return ok({ articles, intent: input.intent, resultCount: articles.length }, speech);
    },
  };
}

export const LOGIN_ISSUES = ["FORGOT_PASSWORD", "FORGOT_USERNAME", "LOCKED_OUT", "MFA_DEVICE_CHANGED", "OTHER"] as const;

export const LoginInput = z.strictObject({
  portal: z.enum(["CLIENT_PORTAL", "PROVIDER_PORTAL", "PARTNER_PORTAL"]),
  issue: z.enum(LOGIN_ISSUES),
  language: LanguageArg,
});
export const LoginOutput = z.strictObject({
  articles: z.array(Article).max(3),
  recoveryRoute: z.enum(["IDENTITY_PROVIDER_SELF_SERVICE_RECOVERY", "TRUSTED_HUMAN_RECOVERY"]),
});

export function getLoginGuidanceTool(s: BusinessServices): ToolModule<z.infer<typeof LoginInput>, z.infer<typeof LoginOutput>> {
  return {
    definition: TOOL_DEFINITIONS.get_login_guidance,
    maskTarget: { collectionKey: "articles", envelopeKeys: ["recoveryRoute"] },
    input: LoginInput,
    output: LoginOutput,
    purpose: () => "public_information",
    resolveResource: async (auth) => openResource(auth, "knowledge_article", "PUBLIC"),
    async execute(ctx, input) {
      // Lockouts and lost MFA devices go to the trusted human recovery process; nothing is reset here.
      const human = input.issue === "LOCKED_OUT" || input.issue === "MFA_DEVICE_CHANGED";
      let hits: KnowledgeHit[];
      try {
        hits = await s.knowledge.search(ctx.auth, { intent: "portal_login_help", query: null, language: input.language.split("-")[0] ?? "en", limit: 2 });
      } catch {
        hits = [];
      }
      const articles = hits.slice(0, 2).map(toArticle);
      const speech = speechFor(s.deps.templates, human ? "login.recovery_human" : "login.guidance", {}, articles.map((a) => a.citationId));
      return ok({ articles, recoveryRoute: human ? "TRUSTED_HUMAN_RECOVERY" : "IDENTITY_PROVIDER_SELF_SERVICE_RECOVERY" }, speech);
    },
  };
}
