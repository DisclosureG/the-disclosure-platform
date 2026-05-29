// Parity guard: the canonical hashing rules are DUPLICATED on purpose across
// three runtimes that can't share a module —
//   • src/lib/wallet-impl.js                       (browser / Vite ESM)
//   • supabase/functions/audit-content-hash/index.ts (Deno edge)
//   • supabase/functions/verify-attestation/index.ts (Deno edge)
// If they ever drift, an on-chain content_hash / node id computed by one side
// stops matching the other, silently breaking tamper detection and attestation
// verification. This test reads each file, extracts the REAL body of each
// hashing function, executes it against shared fixtures, and asserts the bytes
// agree. It deliberately avoids importing the modules (Vite `import.meta.env`
// and Deno `npm:`/`Deno.serve` make that impossible from Node) — it runs only
// the pure function bodies in a sandbox with ethers injected.

const { expect } = require("chai");
const ethers     = require("ethers");
const fs         = require("fs");
const path       = require("path");
const vm         = require("vm");

const ROOT = path.resolve(__dirname, "../..");
const SRC = {
  wallet: path.join(ROOT, "src/lib/wallet-impl.js"),
  audit:  path.join(ROOT, "supabase/functions/audit-content-hash/index.ts"),
  verify: path.join(ROOT, "supabase/functions/verify-attestation/index.ts"),
};

// Tripwire vectors — recomputed from the canonical rule. If a canon change is
// ever made deliberately (across ALL copies), update these too.
const GOLDEN_SLUG    = "0xde60f610a394a6a2a24ae68a94528d84787a32e6054afa6e1246f3f348c9f08b";
const GOLDEN_CONTENT = "0x35abdbe19adaaf43d3c0b21c1130d7f0e16eea43fec7918c77049d4bae1c30ca";
const GOLDEN_META    = "0x1710f89ee74ad2420dd7f219aad5a0adaecbdc0fbf1d58c781ff8d87ef62e2c3";

// Extract the pure-JS body ({ ... }) of a named function from JS or TS source.
// The body carries no type annotations, so it runs as-is. We paren-match the
// parameter list first so TS parameter-type braces (`payload: { title: string }`)
// don't confuse the body brace-matcher.
function extractBody(src, name) {
  const sig = new RegExp(`function\\s+${name}\\s*\\(`).exec(src);
  if (!sig) throw new Error(`function ${name}() not found — was it renamed or removed?`);
  let depth = 0, parenEnd = -1;
  for (let j = src.indexOf("(", sig.index); j < src.length; j++) {
    if (src[j] === "(") depth++;
    else if (src[j] === ")" && --depth === 0) { parenEnd = j; break; }
  }
  let bd = 0, start = src.indexOf("{", parenEnd), end = -1;
  for (let j = start; j < src.length; j++) {
    if (src[j] === "{") bd++;
    else if (src[j] === "}" && --bd === 0) { end = j; break; }
  }
  return src.slice(start, end + 1);
}

// Wrap a body in a function whose signature matches how the body reads its input
// (wallet destructures; the edge copies use `payload.x`), then compile it in a
// sandbox exposing ethers both namespaced (edge style) and bare (wallet's
// destructured-import style).
function compile(body, params) {
  const sandbox = {
    ethers,
    keccak256:   ethers.keccak256,
    toUtf8Bytes: ethers.toUtf8Bytes,
    AbiCoder:    ethers.AbiCoder,
    String, Number, JSON,
  };
  return vm.runInNewContext(`(function (${params}) ${body})`, sandbox);
}

const file = f => fs.readFileSync(f, "utf8");

describe("hash parity — wallet-impl ↔ edge functions", () => {
  const wallet = file(SRC.wallet);
  const audit  = file(SRC.audit);
  const verify = file(SRC.verify);

  const CONTENT_FIXTURES = [
    { title: "Roswell debris field", source: "AARI", year: "1947", excerpt: "Metallic foil recovered", link: "https://example.org/a", tier: 1 },
    { title: "  Padded Title  ",     source: null,    year: null,   excerpt: null,                       link: null,                  tier: 3 },
    { title: "Unicode é ✓ Σ",        source: "Σource", year: 2020,  excerpt: "",                          link: "",                    tier: 2 },
    { title: "x",                    source: "   ",   year: "   ",  excerpt: "   ",                       link: "   ",                 tier: 1 },
  ];
  const SLUG_FIXTURES = ["pillar-default", "topic-default-2", "  spaced slug  ", "unicode-é-✓", ""];
  const UUID_FIXTURES = ["11111111-2222-3333-4444-555555555555", "00000000-0000-0000-0000-000000000000"];
  const META_FIXTURES = [
    { kind: "pillar", slug: "pillar-default",  parent: "",              title: "Default Pillar",     blurb: "b",  tag: "t" },
    { kind: "topic",  slug: "topic-x",         parent: "pillar-default", title: "  Trimmed Topic  ", blurb: null, tag: "" },
    { kind: "pillar", slug: "p2",              parent: "",              title: "é ✓ Σ",              blurb: "",   tag: null },
  ];

  // The wallet hash is now derived from the extracted canonical-JSON builder
  // (canonicalContentJSON / canonicalMetaJSON) — the SAME string that is both
  // hashed AND published on-chain to EvidenceArchive. Hashing it here proves the
  // published string still hashes to the value the edge functions compute.
  const keccakUtf8 = s => ethers.keccak256(ethers.toUtf8Bytes(s));

  it("computeContentHash agrees across wallet-impl, audit-content-hash, and verify-attestation", () => {
    const wCanon = compile(extractBody(wallet, "canonicalContentJSON"), "{ title, source, year, excerpt, link, tier }");
    const a = compile(extractBody(audit,  "computeContentHash"), "payload");
    const v = compile(extractBody(verify, "computeContentHash"), "payload");
    for (const fx of CONTENT_FIXTURES) {
      const label = JSON.stringify(fx);
      const hw = keccakUtf8(wCanon(fx)).toLowerCase();
      expect(hw, `wallet shape for ${label}`).to.match(/^0x[0-9a-f]{64}$/);
      expect(a(fx).toLowerCase(), `audit-content-hash vs wallet for ${label}`).to.equal(hw);
      expect(v(fx).toLowerCase(), `verify-attestation vs wallet for ${label}`).to.equal(hw);
    }
  });

  it("slugToBytes32 agrees across wallet-impl, verify-attestation, and audit-content-hash", () => {
    const w = compile(extractBody(wallet, "slugToBytes32"), "slug");
    const v = compile(extractBody(verify, "slugToBytes32"), "slug");
    const a = compile(extractBody(audit,  "slugToBytes32"), "slug");
    for (const s of SLUG_FIXTURES) {
      const hw = w(s).toLowerCase();
      expect(hw, `wallet shape for slug ${JSON.stringify(s)}`).to.match(/^0x[0-9a-f]{64}$/);
      expect(v(s).toLowerCase(), `verify-attestation vs wallet for slug ${JSON.stringify(s)}`).to.equal(hw);
      expect(a(s).toLowerCase(), `audit-content-hash vs wallet for slug ${JSON.stringify(s)}`).to.equal(hw);
    }
  });

  it("computeMetaHash agrees across wallet-impl and audit-content-hash", () => {
    const wCanon = compile(extractBody(wallet, "canonicalMetaJSON"), "{ kind, slug, parent, title, blurb, tag }");
    const a = compile(extractBody(audit,  "computeMetaHash"), "node");
    for (const fx of META_FIXTURES) {
      const label = JSON.stringify(fx);
      const hw = keccakUtf8(wCanon(fx)).toLowerCase();
      expect(hw, `wallet shape for ${label}`).to.match(/^0x[0-9a-f]{64}$/);
      expect(a(fx).toLowerCase(), `audit-content-hash vs wallet for ${label}`).to.equal(hw);
    }
  });

  it("uuidToBytes32 agrees across wallet-impl and verify-attestation", () => {
    const w = compile(extractBody(wallet, "uuidToBytes32"), "uuid");
    const v = compile(extractBody(verify, "uuidToBytes32"), "uuid");
    for (const u of UUID_FIXTURES) {
      expect(v(u).toLowerCase(), `uuid ${u}`).to.equal(w(u).toLowerCase());
    }
  });

  it("pins the canonical content/slug/meta bytes (tripwire for any silent canon change)", () => {
    const contentCanon = compile(extractBody(wallet, "canonicalContentJSON"), "{ title, source, year, excerpt, link, tier }");
    const slug         = compile(extractBody(wallet, "slugToBytes32"), "slug");
    const metaCanon    = compile(extractBody(wallet, "canonicalMetaJSON"), "{ kind, slug, parent, title, blurb, tag }");
    expect(keccakUtf8(contentCanon({ title: "Roswell", source: "AAF", year: "1947", excerpt: "debris", link: "https://x", tier: 1 })).toLowerCase())
      .to.equal(GOLDEN_CONTENT);
    expect(slug("pillar-default").toLowerCase()).to.equal(GOLDEN_SLUG);
    expect(keccakUtf8(metaCanon({ kind: "pillar", slug: "pillar-default", parent: "", title: "Default Pillar", blurb: "b", tag: "t" })).toLowerCase())
      .to.equal(GOLDEN_META);
  });
});
