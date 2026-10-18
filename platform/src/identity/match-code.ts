import { randomInt } from "node:crypto";

/**
 * Match codes: two words from a fixed list, spoken to the caller and shown in the
 * portal after sign-in so the person can confirm the approval belongs to THIS call
 * (explicit transaction matching, spec section 7). A match code is not a secret
 * and grants nothing on its own; it defeats session swapping (an attacker cannot
 * make a victim's portal show the code the attacker heard) and is generated for
 * every request, eligible or not, so it reveals nothing about account existence.
 *
 * Words are short, common, easy to say and hear on a phone line, and carry no
 * clinical, financial or emotionally loaded meaning.
 */
export const MATCH_CODE_WORDS: readonly string[] = Object.freeze([
  "acorn", "almond", "amber", "anchor", "apple", "apricot", "arrow", "aspen", "atlas", "autumn",
  "badge", "bagel", "ballad", "bamboo", "banjo", "banner", "barley", "basil", "beacon", "beetle",
  "bench", "berry", "birch", "bison", "blossom", "bluebird", "bonnet", "bonsai", "border", "branch",
  "breeze", "brick", "bridge", "brook", "bucket", "butter", "cabbage", "cabin", "cactus", "camel",
  "cameo", "candle", "canoe", "canvas", "canyon", "carpet", "carrot", "cashew", "castle", "cedar",
  "cello", "chalk", "cherry", "chess", "chime", "cider", "cinder", "circle", "citrus", "clover",
  "cobalt", "cobble", "cocoa", "comet", "compass", "copper", "coral", "cotton", "cradle", "crane",
  "crayon", "crystal", "cypress", "dahlia", "daisy", "delta", "denim", "desert", "dewdrop", "diamond",
  "dolphin", "dove", "drum", "dune", "eagle", "echo", "ember", "emerald", "fable", "falcon",
  "feather", "fern", "ferry", "fiddle", "field", "flannel", "flint", "forest", "fossil", "fountain",
  "garden", "garland", "garnet", "gazelle", "geyser", "ginger", "glacier", "globe", "gondola", "granite",
  "grape", "gravel", "hammock", "harbor", "harvest", "hazel", "helmet", "heron", "hickory", "hollow",
  "honey", "horizon", "iceberg", "iris", "island", "ivory", "jade", "jasmine", "jigsaw", "juniper",
  "kayak", "kettle", "kite", "lagoon", "lantern", "laurel", "lemon", "lemur", "lilac", "linen",
  "lizard", "lobster", "lotus", "magnet", "mango", "maple", "marble", "meadow", "melon", "meteor",
  "mint", "mirror", "mitten", "mosaic", "moss", "mountain", "muffin", "nebula", "nectar", "nickel",
  "noodle", "nutmeg", "oasis", "ocean", "olive", "onyx", "orange", "orchard", "otter", "oyster",
  "paddle", "pagoda", "panda", "paper", "parrot", "pearl", "pebble", "pelican", "pepper", "piano",
  "pillow", "planet", "plum", "pocket", "pond", "poppy", "prairie", "puffin", "pumpkin", "quartz",
  "quill", "rabbit", "radish", "raisin", "raven", "ribbon", "ridge", "river", "robin", "rocket",
  "ruby", "saddle", "saffron", "salmon", "sapphire", "satin", "sequoia", "sherbet", "silver", "slate",
  "sonnet", "sparrow", "spindle", "sprout", "spruce", "summer", "sunset", "swan", "teapot", "thimble",
  "thistle", "thunder", "tiger", "timber", "topaz", "toucan", "trellis", "trumpet", "tulip", "tundra",
  "turtle", "tuxedo", "umbrella", "valley", "vanilla", "velvet", "violet", "waffle", "walnut", "walrus",
  "willow", "window", "winter", "wren", "yarrow", "zebra", "aurora", "bobcat", "button", "cocoon",
  "glider", "hilltop", "marigold", "nutshell", "pinecone", "seashell",
]);

export const MATCH_CODE_PATTERN = /^[a-z]{3,10}-[a-z]{3,10}$/;

/** Two distinct words, chosen with a CSPRNG. ~16 bits; enough to detect a swapped approval, never used as a secret. */
export function newMatchCode(): string {
  const n = MATCH_CODE_WORDS.length;
  const a = randomInt(n);
  let b = randomInt(n - 1);
  if (b >= a) b += 1;
  return `${MATCH_CODE_WORDS[a]}-${MATCH_CODE_WORDS[b]}`;
}
