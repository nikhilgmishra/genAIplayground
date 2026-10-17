/**
 * Embeddings for the APPROVED knowledge corpus (spec section 9: "PostgreSQL
 * full text plus pgvector over the approved knowledge corpus only").
 *
 * `LocalHashingEmbedder` is a LOCAL FIXTURE: a deterministic feature-hashing
 * bag of stemmed unigrams and bigrams, L2-normalized. It is not a semantic
 * model; it exists so the pgvector path (schema, filters-before-similarity,
 * hybrid ranking) is exercised offline. A real embedding model is BLOCKED
 * pending model selection approval (MODEL_VOICE_SELECTION) and, because search
 * queries are caller utterances, BAA coverage for that endpoint (DATA-01).
 * Production refuses this embedder (OPS-04, enforced by KnowledgeServicePg).
 *
 * Customer transcripts are never embedded: only approved knowledge items and
 * the transient query are.
 */
import { createHash } from "node:crypto";

export const EMBEDDING_DIMENSIONS = 256;

export interface KnowledgeEmbedder {
  readonly kind: "local_fixture" | "live";
  /** Pinned model identifier stored with every vector (OPS-06). */
  readonly modelId: string;
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
}

const STOPWORDS = new Set(
  (
    "a an and are as at be been but by can could did do does for from had has have how i if in into is it its may me my no not of on or our " +
    "out so than that the their them then there these they this to too up us was we were what when where which who why will with would you your " +
    "el la los las un una y o de del en es por para con que se su sus al lo"
  ).split(" "),
);

/** Light, deterministic English suffix stripping (enough for fixture matching; not a linguistic stemmer). */
export function stem(word: string): string {
  let w = word;
  for (const suffix of ["ations", "ation", "ments", "ment", "ings", "ing", "edly", "ies", "ied", "ed", "es", "s"]) {
    if (w.length > suffix.length + 3 && w.endsWith(suffix)) {
      w = w.slice(0, -suffix.length);
      if (suffix === "ies" || suffix === "ied") w += "y";
      break;
    }
  }
  return w;
}

/** Lowercased, accent-folded, stop-word-free stems. */
export function tokenize(text: string): string[] {
  const folded = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const out: string[] = [];
  for (const m of folded.matchAll(/[a-z0-9]+/g)) {
    const w = m[0];
    if (w.length < 2 || STOPWORDS.has(w)) continue;
    out.push(stem(w));
  }
  return out;
}

function bucket(feature: string, dims: number): { index: number; sign: number } {
  const h = createHash("sha256").update(feature).digest();
  const index = h.readUInt32BE(0) % dims;
  const sign = (h[4] ?? 0) & 1 ? 1 : -1;
  return { index, sign };
}

export function hashingEmbedding(text: string, dims = EMBEDDING_DIMENSIONS): number[] {
  const v = new Array<number>(dims).fill(0);
  const toks = tokenize(text);
  const add = (feature: string, weight: number) => {
    const b = bucket(feature, dims);
    v[b.index] = (v[b.index] ?? 0) + b.sign * weight;
  };
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i] ?? "";
    add(`u:${t}`, 1);
    const next = toks[i + 1];
    if (next) add(`b:${t}_${next}`, 0.5);
  }
  const norm = Math.sqrt(v.reduce((acc, x) => acc + x * x, 0));
  return norm === 0 ? v : v.map((x) => Math.round((x / norm) * 1e6) / 1e6);
}

/** LOCAL FIXTURE embedder (deterministic feature hashing). */
export class LocalHashingEmbedder implements KnowledgeEmbedder {
  readonly kind = "local_fixture" as const;
  readonly modelId = "local-hash-embed-v1";
  readonly dimensions = EMBEDDING_DIMENSIONS;
  async embed(text: string): Promise<number[]> {
    return hashingEmbedding(text, this.dimensions);
  }
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** pgvector text literal. */
export const toVectorLiteral = (v: readonly number[]): string => `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(",")}]`;
