import { useState, useEffect, useCallback } from 'react';
import nacl from 'tweetnacl';
import { decodeBase64, encodeBase64, decodeUTF8, encodeUTF8 } from 'tweetnacl-util';

const ESCROW_ADDR = import.meta.env.VITE_ESCROW_ADDR ?? "0x194Cb87E06cEf23Cd6f37Ef83C27761b07490C44";
const DOGE_BEP20  = import.meta.env.VITE_DOGE_ADDR   ?? "0xf328840bAdbAd51a207f2A6618D75567F2dEEc07";
const PEPE_BEP20  = import.meta.env.VITE_PEPE_ADDR   ?? "0xb642364705c6e009299d32eba9Abbcb54e197065";
const CHAIN_ID    = import.meta.env.VITE_CHAIN_ID    ?? "0x38";

const EXPLORER_TX   = CHAIN_ID === "0x61" ? "https://testnet.bscscan.com/tx/"      : "https://bscscan.com/tx/";
const EXPLORER_ADDR = CHAIN_ID === "0x61" ? "https://testnet.bscscan.com/address/" : "https://bscscan.com/address/";

// Precomputed with `cast sig`
const SEL_AUTHOR          = "0xa6c3e6b9"; // author()
const SEL_GET_ORDER       = "0x5778472a"; // getOrder(bytes32)
const SEL_FULFILL         = "0x9d15f88e"; // fulfillOrder(bytes32,bytes32,bytes)
const SEL_RELEASE_PROFIT  = "0x7ac96a56"; // releaseProfit(bytes32)
const SEL_UPDATE_TRACKING = "0xb8bd576c"; // updateTracking(bytes32,bytes)

// OrderCreated(bytes32 indexed id, address indexed buyer, address token, uint256 cost, uint256 profit, bytes32 buyerPubKey)
const TOPIC_ORDER_CREATED = "0xa30b4da0e57cd7dda9e37536547519f3ac17a06fcf6250babd9c70015c2140a8";

const DISPUTE_DAYS  = 99;
const STATUS_LABEL  = ["Paid", "Fulfilled", "Released", "Refunded"];

const DEPLOY_BLOCK    = import.meta.env.VITE_DEPLOY_BLOCK ?? "0";
const BSCSCAN_KEY     = import.meta.env.VITE_BSCSCAN_API_KEY ?? "";
const AUTHOR_SHIPPING_PUBKEY_CONFIGURED = !!import.meta.env.VITE_AUTHOR_SHIPPING_PUBKEY;
const AUTHOR_SHIPPING_SIGN_MSG = "Interstellar Psychology author shipping key v1";
// Public RPC used for eth_getLogs — MetaMask's provider doesn't support it reliably.
const RPC_URL    = CHAIN_ID === "0x61"
  ? "https://bsc-testnet-rpc.publicnode.com"
  : "https://bsc-dataseed.binance.org";
const BSCSCAN_API = CHAIN_ID === "0x61"
  ? "https://api-testnet.bscscan.com/api"
  : "https://api.bscscan.com/api";
const CHUNK_SIZE = 49_999;

/* ── Low-level helpers ────────────────────────────────────────── */

function pad32(val) {
  const hex = typeof val === "bigint" ? val.toString(16) : String(val).replace(/^0x/i, "");
  return hex.toLowerCase().padStart(64, "0");
}

async function ethCall(data) {
  return window.ethereum.request({
    method: "eth_call",
    params: [{ to: ESCROW_ADDR, data }, "latest"],
  });
}

async function rpc(method, params = []) {
  const res  = await fetch(RPC_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || "RPC error");
  return json.result;
}

// Fetches OrderCreated logs via BscScan API (full history, no pruning).
// Falls back to chunked RPC when no API key is configured.
async function ethLogsRpc() {
  const latest = parseInt(await rpc("eth_blockNumber"), 16);
  const parsed = parseInt(DEPLOY_BLOCK, 10);
  const from   = (parsed > 0 && parsed <= latest) ? parsed : Math.max(0, latest - CHUNK_SIZE);

  const all = [];
  for (let lo = from; lo <= latest; lo += CHUNK_SIZE) {
    const hi = Math.min(lo + CHUNK_SIZE - 1, latest);
    try {
      const chunk = await rpc("eth_getLogs", [{
        address:   ESCROW_ADDR,
        topics:    [TOPIC_ORDER_CREATED],
        fromBlock: "0x" + lo.toString(16),
        toBlock:   "0x" + hi.toString(16),
      }]);
      all.push(...chunk);
    } catch {
      // pruned range — skip
    }
  }
  return all;
}

async function ethLogs() {
  if (BSCSCAN_KEY) {
    try {
      const params = new URLSearchParams({
        module:    "logs",
        action:    "getLogs",
        address:   ESCROW_ADDR,
        topic0:    TOPIC_ORDER_CREATED,
        fromBlock: DEPLOY_BLOCK || "0",
        toBlock:   "latest",
        apikey:    BSCSCAN_KEY,
      });
      const res  = await fetch(`${BSCSCAN_API}?${params}`);
      const json = await res.json();
      if (json.status === "1") return json.result;
      if (json.message === "No records found") return [];
      // BscScan error — fall through to RPC
    } catch {
      // network error — fall through to RPC
    }
  }
  return ethLogsRpc();
}

// Look up a single order by ID directly via eth_call — no BscScan needed.
async function fetchOrderById(id) {
  const raw = await ethCall(SEL_GET_ORDER + pad32(id));
  const d   = decodeOrder(raw);
  if (!d || d.buyer === "0x" + "0".repeat(40)) return null;
  return { id, ...d };
}

async function waitReceipt(hash) {
  for (;;) {
    await new Promise(r => setTimeout(r, 2000));
    const r = await window.ethereum.request({
      method: "eth_getTransactionReceipt",
      params: [hash],
    });
    if (r) {
      if (r.status === "0x0") throw new Error("Transaction reverted on-chain.");
      return r;
    }
  }
}

function decodeOrder(hex) {
  const d = hex.slice(2);
  if (d.length < 576) return null; // 9 slots × 64 hex chars
  const s = i => d.slice(i * 64, (i + 1) * 64);
  return {
    buyer:        "0x" + s(0).slice(24),
    token:        "0x" + s(1).slice(24),
    cost:         BigInt("0x" + s(2)),
    profit:       BigInt("0x" + s(3)),
    createdAt:    Number(BigInt("0x" + s(4))),
    fulfilledAt:  Number(BigInt("0x" + s(5))),
    shippingHash: "0x" + s(6),
    buyerPubKey:  "0x" + s(7),
    status:       Number(BigInt("0x" + s(8))),
  };
}

function parseCreatedLog(log) {
  // topics: [sig, id (indexed), buyer (indexed)]
  // data:   token (32) + cost (32) + profit (32) + buyerPubKey (32)
  const d = log.data.slice(2);
  return {
    id:          log.topics[1],
    buyer:       "0x" + log.topics[2].slice(26),
    token:       "0x" + d.slice(24, 64),
    cost:        BigInt("0x" + d.slice(64, 128)),
    profit:      BigInt("0x" + d.slice(128, 192)),
    buyerPubKey: "0x" + d.slice(192, 256),
    txHash:      log.transactionHash,
  };
}

async function deriveAuthorKeyPair(account) {
  const msgHex = "0x" + Array.from(new TextEncoder().encode(AUTHOR_SHIPPING_SIGN_MSG), b => b.toString(16).padStart(2, "0")).join("");
  const sig      = await window.ethereum.request({ method: "personal_sign", params: [msgHex, account] });
  const sigBytes = new Uint8Array(sig.slice(2).match(/.{2}/g).map(b => parseInt(b, 16)));
  const km       = await crypto.subtle.importKey("raw", sigBytes, { name: "HKDF" }, false, ["deriveBits"]);
  const bits     = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256",
      salt: new TextEncoder().encode("nacl-box-key-v1"),
      info: new TextEncoder().encode("author-shipping") },
    km, 256,
  );
  return nacl.box.keyPair.fromSecretKey(new Uint8Array(bits));
}

async function resolveOrderTxHash(orderId) {
  if (BSCSCAN_KEY) {
    try {
      const params = new URLSearchParams({
        module:       "logs",
        action:       "getLogs",
        address:      ESCROW_ADDR,
        topic0:       TOPIC_ORDER_CREATED,
        topic0_1_opr: "and",
        topic1:       orderId,
        fromBlock:    DEPLOY_BLOCK || "0",
        toBlock:      "latest",
        apikey:       BSCSCAN_KEY,
      });
      const res  = await fetch(`${BSCSCAN_API}?${params}`);
      const json = await res.json();
      if (json.status === "1" && json.result?.length) return json.result[0].transactionHash;
      // BscScan error or no result — fall through to RPC
    } catch {
      // network error — fall through to RPC
    }
  }

  // RPC fallback — scan backwards in CHUNK_SIZE-block windows; skip pruned ranges.
  const deployBlock = Math.max(0, parseInt(DEPLOY_BLOCK, 10));
  const latest      = parseInt(await rpc("eth_blockNumber", []), 16);

  for (let to = latest; to >= deployBlock; to -= CHUNK_SIZE) {
    const from = Math.max(to - CHUNK_SIZE + 1, deployBlock);
    try {
      const logs = await rpc("eth_getLogs", [{
        address:   ESCROW_ADDR,
        topics:    [TOPIC_ORDER_CREATED, orderId],
        fromBlock: "0x" + from.toString(16),
        toBlock:   "0x" + to.toString(16),
      }]);
      if (logs?.length) return logs[0].transactionHash;
    } catch {
      // pruned range — continue scanning
    }
  }
  throw new Error("Creation event not found — check VITE_DEPLOY_BLOCK.");
}

async function fetchAndDecryptShipping(orderId, txHash, authorKeyPair) {
  const resolvedHash = txHash ?? await resolveOrderTxHash(orderId);
  const tx = await rpc("eth_getTransactionByHash", [resolvedHash]);
  if (!tx?.input) throw new Error("Transaction not found on-chain.");
  // selector(4B) + 5 params(32B each) = 164 bytes = 328 hex chars; skip "0x" prefix
  const OFFSET = 2 + (4 + 5 * 32) * 2;
  const extra  = tx.input.slice(OFFSET);
  if (!extra) return null;  // no extra bytes = no shipping data (not an error)
  const jsonStr = new TextDecoder().decode(
    new Uint8Array(extra.match(/.{2}/g).map(b => parseInt(b, 16)))
  );
  let parsed;
  try { parsed = JSON.parse(jsonStr); }
  catch { throw new Error("Calldata payload is not valid JSON — may be a pre-feature order."); }
  if (parsed.version !== "x25519-xsalsa20-poly1305")
    throw new Error(`Unknown payload format: ${parsed.version}`);
  const decrypted = nacl.box.open(
    decodeBase64(parsed.ciphertext),
    decodeBase64(parsed.nonce),
    decodeBase64(parsed.ephemPublicKey),
    authorKeyPair.secretKey,
  );
  if (!decrypted) throw new Error("Decryption failed — keypair mismatch?");
  return new TextDecoder().decode(decrypted);
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return "0x" + Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, "0")).join("");
}

/* ── Formatters ───────────────────────────────────────────────── */

function shorten(s, l = 6, r = 4) {
  return s ? s.slice(0, l) + "…" + s.slice(-r) : "—";
}

function fmtWei(wei, dec) {
  return (Number(wei) / 10 ** dec).toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function fmtTs(ts) {
  return ts ? new Date(ts * 1000).toLocaleString() : "—";
}

function windowLeft(fulfilledAt) {
  const endsAt = (fulfilledAt + DISPUTE_DAYS * 86400) * 1000;
  const diff   = endsAt - Date.now();
  if (diff <= 0) return { expired: true, label: "Window closed" };
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  return { expired: false, label: `${d}d ${h}h remaining` };
}

function tokenInfo(addr) {
  if (addr.toLowerCase() === DOGE_BEP20.toLowerCase()) return { symbol: "DOGE", decimals: 8 };
  if (addr.toLowerCase() === PEPE_BEP20.toLowerCase()) return { symbol: "PEPE", decimals: 18 };
  return { symbol: shorten(addr, 6, 4), decimals: 18 };
}

/* ── Copy chip (reused from PurchaseModal) ────────────────────── */

function CopyChip({ value, label, children }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={`copy-chip ${done ? "is-copied" : ""}`}
      aria-label={`Copy ${label}`}
      onClick={async e => {
        e.stopPropagation();
        try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1400); } catch {}
      }}
    >
      <span>{children ?? value}</span>
      <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
        {done
          ? <path d="M5 13l4 4L19 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
          : <g fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/></g>
        }
      </svg>
    </button>
  );
}

/* ── NaCl encrypt helper ──────────────────────────────────────── */

function encryptForBuyer(trackingText, buyerPubKeyHex) {
  // buyerPubKeyHex is a 0x-prefixed 64-char hex string (raw 32 bytes)
  const buyerPubKey = new Uint8Array(
    buyerPubKeyHex.slice(2).match(/.{2}/g).map(b => parseInt(b, 16))
  );
  const ephemKeyPair = nacl.box.keyPair();
  const nonce        = nacl.randomBytes(nacl.box.nonceLength);
  const message      = decodeUTF8(trackingText);
  const box          = nacl.box(message, nonce, buyerPubKey, ephemKeyPair.secretKey);

  // MetaMask eth_decrypt expects this exact JSON shape
  return JSON.stringify({
    version:        "x25519-xsalsa20-poly1305",
    nonce:          encodeBase64(nonce),
    ephemPublicKey: encodeBase64(ephemKeyPair.publicKey),
    ciphertext:     encodeBase64(box),
  });
}

// ABI-encode updateTracking(bytes32,bytes) calldata
function encodeUpdateTracking(orderId, encryptedJsonStr) {
  const encoder  = new TextEncoder();
  const rawBytes = encoder.encode(encryptedJsonStr);
  const len      = rawBytes.length;
  const padded   = new Uint8Array(Math.ceil(len / 32) * 32);
  padded.set(rawBytes);
  const dataHex  = Array.from(padded, b => b.toString(16).padStart(2, "0")).join("");
  const lenHex   = len.toString(16).padStart(64, "0");
  // offset: 2 static slots (id, offset itself) = 64 = 0x40
  const offsetHex = "0000000000000000000000000000000000000000000000000000000000000040";
  return SEL_UPDATE_TRACKING + pad32(orderId) + offsetHex + lenHex + dataHex;
}

// ABI-encode fulfillOrder(bytes32,bytes32,bytes) calldata
function encodeFulfill(orderId, shippingHash, encryptedJsonStr) {
  const encoder   = new TextEncoder();
  const rawBytes  = encoder.encode(encryptedJsonStr);
  const len       = rawBytes.length;
  // pad to 32-byte boundary
  const padded    = new Uint8Array(Math.ceil(len / 32) * 32);
  padded.set(rawBytes);
  const dataHex   = Array.from(padded, b => b.toString(16).padStart(2, "0")).join("");
  const lenHex    = len.toString(16).padStart(64, "0");
  // offset: 3 static slots (id, shippingHash, offset itself) = 96 = 0x60
  const offsetHex = "0000000000000000000000000000000000000000000000000000000000000060";
  return SEL_FULFILL + pad32(orderId) + pad32(shippingHash) + offsetHex + lenHex + dataHex;
}

/* ── Fulfill modal ────────────────────────────────────────────── */

function FulfillModal({ order, account, authorKeyPair, onSign, onClose, onDone }) {
  const [tracking,        setTracking]        = useState("");
  const [proofHash,       setProofHash]       = useState(null);
  const [encrypted,       setEncrypted]       = useState(null);
  const [phase,           setPhase]           = useState("idle");
  const [txHash,          setTxHash]          = useState(null);
  const [err,             setErr]             = useState(null);
  const [shipping,        setShipping]        = useState(null);
  const [loadingShipping, setLoadingShipping] = useState(false);
  const [shippingErr,     setShippingErr]     = useState(null);

  useEffect(() => {
    if (!authorKeyPair) return;
    setLoadingShipping(true);
    setShippingErr(null);
    fetchAndDecryptShipping(order.id, order.txHash, authorKeyPair)
      .then(s => setShipping(s))
      .catch(e => setShippingErr(e.message))
      .finally(() => setLoadingShipping(false));
  }, [authorKeyPair, order.id]);

  const zeroPubKey = !order.buyerPubKey || order.buyerPubKey === "0x" + "0".repeat(64);

  const computeProof = async () => {
    if (!tracking.trim()) return;
    const h = await sha256Hex(tracking.trim());
    setProofHash(h);
    if (!zeroPubKey) {
      try {
        const enc = encryptForBuyer(tracking.trim(), order.buyerPubKey);
        setEncrypted(enc);
      } catch (e) {
        setErr("Encryption failed: " + e.message);
      }
    } else {
      // No buyer pubkey — store plaintext so the buyer UI can still display it.
      setEncrypted(JSON.stringify({ version: "plaintext", tracking: tracking.trim() }));
    }
  };

  const submit = async () => {
    if (!proofHash) return;
    setErr(null);
    setPhase("sign");
    try {
      const data = encodeFulfill(order.id, proofHash, encrypted ?? "");
      const tx = await window.ethereum.request({
        method: "eth_sendTransaction",
        params: [{ from: account, to: ESCROW_ADDR, data }],
      });
      setTxHash(tx);
      setPhase("mine");
      await waitReceipt(tx);
      setPhase("done");
      setTimeout(onDone, 1200);
    } catch (e) {
      setErr(e.code === 4001 ? "Rejected." : (e.message || "Failed."));
      setPhase("idle");
    }
  };

  return (
    <div className="admin-backdrop" onClick={onClose}>
      <div className="admin-dialog" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <button className="modal-close" onClick={onClose} aria-label="Close">×</button>

        <div className="dapp-eyebrow" style={{ marginBottom: 6 }}>Fulfill order</div>
        <h3 className="dapp-h">Mark order as shipped.</h3>

        <div className="tx-card" style={{ margin: "18px 0" }}>
          <div className="tx-row">
            <span>Order ID</span>
            <CopyChip value={order.id} label="order id"><code>{shorten(order.id, 10, 8)}</code></CopyChip>
          </div>
          <div className="tx-row">
            <span>Buyer</span>
            <CopyChip value={order.buyer} label="buyer"><code>{shorten(order.buyer)}</code></CopyChip>
          </div>
          <div className="tx-row">
            <span>Encryption</span>
            <span>{zeroPubKey ? "⚠ No pubkey — tracking stored as plaintext" : "✓ Buyer pubkey on-chain"}</span>
          </div>
        </div>

        <div className="admin-shipping-box">
          <span className="dapp-eyebrow">Ship to</span>
          {!authorKeyPair && <button className="btn" style={{ marginTop: 6 }} onClick={onSign}>Sign to decrypt →</button>}
          {authorKeyPair && loadingShipping && <p className="dapp-sub" style={{ marginTop: 6 }}>Decrypting…</p>}
          {authorKeyPair && !loadingShipping && shipping && <pre className="admin-shipping-addr">{shipping}</pre>}
          {authorKeyPair && !loadingShipping && !shipping && !shippingErr && <p className="dapp-sub" style={{ marginTop: 6, opacity: 0.6 }}>Buyer did not enter a shipping address.</p>}
          {authorKeyPair && shippingErr && <p className="admin-err" style={{ marginTop: 6 }}>{shippingErr}</p>}
        </div>

        <label className="dapp-field">
          <span className="dapp-eyebrow">Tracking number / shipping reference</span>
          <input
            type="text"
            placeholder="e.g. 1Z999AA10123456784"
            value={tracking}
            onChange={e => { setTracking(e.target.value); setProofHash(null); setEncrypted(null); }}
          />
          <small className="dapp-fineprint">
            SHA-256 of this is posted on-chain as proof.
            {!zeroPubKey && " The tracking number itself is encrypted with the buyer's public key — only their MetaMask can decrypt it."}
          </small>
        </label>

        {tracking.trim() && !proofHash && (
          <button className="btn" style={{ marginTop: 10 }} onClick={computeProof}>
            {zeroPubKey ? "Compute proof hash →" : "Encrypt & compute hash →"}
          </button>
        )}

        {proofHash && (
          <div className="admin-proof-row">
            <span className="dapp-eyebrow">On-chain shipping hash (SHA-256)</span>
            <CopyChip value={proofHash} label="shipping hash">
              <code style={{ fontSize: 11, wordBreak: "break-all" }}>{proofHash}</code>
            </CopyChip>
            {encrypted && (
              <small className="dapp-fineprint" style={{ marginTop: 6, display: "block" }}>
                Tracking encrypted · {new TextEncoder().encode(encrypted).length} bytes stored on-chain.
              </small>
            )}
          </div>
        )}

        {err && <p className="admin-err">{err}</p>}
        {txHash && (
          <p className="dapp-fineprint" style={{ marginTop: 12 }}>
            Tx:{" "}
            <a className="dapp-link" href={EXPLORER_TX + txHash} target="_blank" rel="noreferrer">
              {shorten(txHash, 10, 8)} ↗
            </a>
          </p>
        )}

        <div className="dapp-actions" style={{ marginTop: 20 }}>
          <button className="btn" onClick={onClose} disabled={phase !== "idle"}>Cancel</button>
          <button
            className="btn btn-primary"
            disabled={!proofHash || phase !== "idle"}
            onClick={submit}
          >
            {phase === "idle"  ? <>Fulfill &amp; release cost <span className="btn-arrow">→</span></> :
             phase === "sign"  ? "Awaiting MetaMask…" :
             phase === "mine"  ? "Confirming on-chain…" :
                                 "Done ✓"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Order card ───────────────────────────────────────────────── */

function UpdateTrackingModal({ order, account, onClose, onDone }) {
  const [tracking, setTracking] = useState("");
  const [phase,    setPhase]    = useState("idle");
  const [txHash,   setTxHash]   = useState(null);
  const [err,      setErr]      = useState(null);

  const zeroPubKey = !order.buyerPubKey || order.buyerPubKey === "0x" + "0".repeat(64);

  const submit = async () => {
    if (!tracking.trim()) return;
    setErr(null);
    setPhase("sign");
    try {
      const jsonStr = zeroPubKey
        ? JSON.stringify({ version: "plaintext", tracking: tracking.trim() })
        : encryptForBuyer(tracking.trim(), order.buyerPubKey);
      const data = encodeUpdateTracking(order.id, jsonStr);
      const tx = await window.ethereum.request({
        method: "eth_sendTransaction",
        params: [{ from: account, to: ESCROW_ADDR, data }],
      });
      setTxHash(tx);
      setPhase("mine");
      await waitReceipt(tx);
      setPhase("done");
      setTimeout(onDone, 1200);
    } catch (e) {
      setErr(e.code === 4001 ? "Rejected." : (e.message || "Failed."));
      setPhase("idle");
    }
  };

  return (
    <div className="admin-backdrop" onClick={onClose}>
      <div className="admin-dialog" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        <div className="dapp-eyebrow" style={{ marginBottom: 6 }}>Update tracking</div>
        <h3 className="dapp-h">Store tracking number on-chain.</h3>
        <p className="dapp-sub" style={{ marginTop: 8 }}>
          {zeroPubKey
            ? "No buyer pubkey — tracking will be stored as plaintext."
            : "Tracking will be encrypted with the buyer's public key."}
        </p>
        <label className="dapp-field" style={{ marginTop: 16 }}>
          <span className="dapp-eyebrow">Tracking number</span>
          <input type="text" placeholder="e.g. 1Z999AA10123456784" value={tracking}
            onChange={e => setTracking(e.target.value)} />
        </label>
        {err && <p className="admin-err">{err}</p>}
        {txHash && (
          <p className="dapp-fineprint" style={{ marginTop: 12 }}>
            Tx: <a className="dapp-link" href={EXPLORER_TX + txHash} target="_blank" rel="noreferrer">{shorten(txHash, 10, 8)} ↗</a>
          </p>
        )}
        <div className="dapp-actions" style={{ marginTop: 20 }}>
          <button className="btn" onClick={onClose} disabled={phase !== "idle"}>Cancel</button>
          <button className="btn btn-primary" disabled={!tracking.trim() || phase !== "idle"} onClick={submit}>
            {phase === "idle" ? <>Store on-chain <span className="btn-arrow">→</span></> :
             phase === "sign" ? "Awaiting MetaMask…" :
             phase === "mine" ? "Confirming…" : "Done ✓"}
          </button>
        </div>
      </div>
    </div>
  );
}

function OrderCard({ order, account, authorKeyPair, onSign, onRefresh }) {
  const [fulfillOpen,     setFulfillOpen]     = useState(false);
  const [updateOpen,      setUpdateOpen]      = useState(false);
  const [releasing,       setReleasing]       = useState(false);
  const [relTx,           setRelTx]           = useState(null);
  const [err,             setErr]             = useState(null);
  const [shipping,        setShipping]        = useState(null);
  const [loadingShipping, setLoadingShipping] = useState(false);
  const [shippingErr,     setShippingErr]     = useState(null);

  useEffect(() => {
    if (!authorKeyPair) return;
    setLoadingShipping(true);
    setShippingErr(null);
    fetchAndDecryptShipping(order.id, order.txHash, authorKeyPair)
      .then(s => setShipping(s))
      .catch(e => setShippingErr(e.message))
      .finally(() => setLoadingShipping(false));
  }, [authorKeyPair, order.id]);

  const { symbol, decimals } = tokenInfo(order.token);
  const tl       = order.status === 1 && order.fulfilledAt ? windowLeft(order.fulfilledAt) : null;
  const zeroHash = "0x" + "0".repeat(64);

  const releaseProfit = async () => {
    setErr(null);
    setReleasing(true);
    try {
      const data = SEL_RELEASE_PROFIT + pad32(order.id);
      const tx = await window.ethereum.request({
        method: "eth_sendTransaction",
        params: [{ from: account, to: ESCROW_ADDR, data }],
      });
      setRelTx(tx);
      await waitReceipt(tx);
      onRefresh();
    } catch (e) {
      setErr(e.code === 4001 ? "Rejected." : (e.message || "Failed."));
    } finally {
      setReleasing(false);
    }
  };

  return (
    <div className={`admin-card admin-card--s${order.status}`}>
      <div className="admin-card-head">
        <div className="admin-card-id-row">
          <span className={`admin-badge admin-badge--s${order.status}`}>
            {STATUS_LABEL[order.status]}
          </span>
          <CopyChip value={order.id} label="order id">
            <code className="admin-oid">{shorten(order.id, 10, 8)}</code>
          </CopyChip>
        </div>
        <span className="admin-card-token">{symbol}</span>
      </div>

      <dl className="admin-dl">
        <dt>Buyer</dt>
        <dd>
          <CopyChip value={order.buyer} label="buyer">
            <code>{shorten(order.buyer)}</code>
          </CopyChip>
        </dd>

        <dt>Cost (print + ship)</dt>
        <dd><strong>{fmtWei(order.cost, decimals)} {symbol}</strong></dd>

        <dt>Profit (escrowed)</dt>
        <dd><strong>{fmtWei(order.profit, decimals)} {symbol}</strong></dd>

        <dt>Ship to</dt>
        <dd>
          {!authorKeyPair && <em style={{ opacity: 0.5 }}>Sign required</em>}
          {authorKeyPair && loadingShipping && <em style={{ opacity: 0.5 }}>Decrypting…</em>}
          {authorKeyPair && !loadingShipping && shipping && <pre className="admin-shipping-addr">{shipping}</pre>}
          {authorKeyPair && !loadingShipping && !shipping && !shippingErr && <em style={{ opacity: 0.5 }}>—</em>}
          {authorKeyPair && shippingErr && <em style={{ color: "var(--warn, #f87171)", fontSize: 11 }}>{shippingErr}</em>}
        </dd>

        <dt>Created</dt>
        <dd>{fmtTs(order.createdAt)}</dd>

        {order.fulfilledAt > 0 && (
          <>
            <dt>Fulfilled</dt>
            <dd>{fmtTs(order.fulfilledAt)}</dd>
          </>
        )}

        {tl && (
          <>
            <dt>Dispute window</dt>
            <dd className={tl.expired ? "admin-expired" : "admin-live"}>{tl.label}</dd>
          </>
        )}

        {order.status === 1 && order.shippingHash !== zeroHash && (
          <>
            <dt>Shipping hash</dt>
            <dd>
              <CopyChip value={order.shippingHash} label="shipping hash">
                <code style={{ fontSize: 11 }}>{shorten(order.shippingHash, 12, 10)}</code>
              </CopyChip>
            </dd>
          </>
        )}
      </dl>

      {err   && <p className="admin-err">{err}</p>}
      {relTx && (
        <p className="dapp-fineprint" style={{ marginTop: 8 }}>
          Tx:{" "}
          <a className="dapp-link" href={EXPLORER_TX + relTx} target="_blank" rel="noreferrer">
            {shorten(relTx, 10, 8)} ↗
          </a>
        </p>
      )}

      <div className="admin-card-foot">
        {order.status === 0 && (
          <button className="btn btn-primary" onClick={() => setFulfillOpen(true)}>
            Mark as fulfilled →
          </button>
        )}

        {order.status === 1 && tl?.expired && (
          <button className="btn btn-primary" onClick={releaseProfit} disabled={releasing}>
            {releasing ? "Releasing…" : <>Release profit <span className="btn-arrow">→</span></>}
          </button>
        )}

        {order.status === 1 && (
          <button className="btn" style={{ marginTop: 8 }} onClick={() => setUpdateOpen(true)}>
            Update tracking →
          </button>
        )}

        {order.status === 1 && !tl?.expired && (
          <p className="admin-window-note">
            Dispute window open — profit auto-releases after expiry.
          </p>
        )}

        {(order.status === 2 || order.status === 3) && (
          <p className="admin-window-note">Order concluded.</p>
        )}
      </div>

      {fulfillOpen && (
        <FulfillModal
          order={order}
          account={account}
          authorKeyPair={authorKeyPair}
          onSign={onSign}
          onClose={() => setFulfillOpen(false)}
          onDone={() => { setFulfillOpen(false); onRefresh(); }}
        />
      )}
      {updateOpen && (
        <UpdateTrackingModal
          order={order}
          account={account}
          onClose={() => setUpdateOpen(false)}
          onDone={() => { setUpdateOpen(false); onRefresh(); }}
        />
      )}
    </div>
  );
}

/* ── Manual order lookup (fallback when BscScan is unavailable) ── */

function ManualLookup({ account, onFound }) {
  const [input,   setInput]   = useState("");
  const [loading, setLoading] = useState(false);
  const [err,     setErr]     = useState(null);

  const lookup = async () => {
    const id = input.trim();
    if (!id) return;
    setErr(null);
    setLoading(true);
    try {
      const order = await fetchOrderById(id.startsWith("0x") ? id : "0x" + id);
      if (!order) { setErr("Order not found — check the ID and try again."); return; }
      onFound(order);
    } catch (e) {
      setErr(e.message || "Lookup failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="admin-lookup">
      <div className="dapp-eyebrow" style={{ marginBottom: 8 }}>Lookup by Order ID</div>
      <p className="dapp-sub" style={{ marginBottom: 14 }}>
        Paste the <code>bytes32</code> order ID from the buyer's transaction to load it directly
        — no BscScan required.
      </p>
      <div className="admin-lookup-row">
        <label className="dapp-field" style={{ flex: 1, margin: 0 }}>
          <input
            type="text"
            placeholder="0x1234…abcd"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === "Enter" && lookup()}
          />
        </label>
        <button className="btn btn-primary" onClick={lookup} disabled={loading || !input.trim()}>
          {loading ? "…" : "Look up →"}
        </button>
      </div>
      {err && <p className="admin-err" style={{ marginTop: 8 }}>{err}</p>}
    </div>
  );
}

/* ── Root ─────────────────────────────────────────────────────── */

export default function AuthorAdmin() {
  const [account,        setAccount]        = useState(null);
  const [authErr,        setAuthErr]        = useState(null);
  const [connecting,     setConnecting]     = useState(false);
  const [orders,         setOrders]         = useState([]);
  const [loading,        setLoading]        = useState(false);
  const [logErr,         setLogErr]         = useState(null);
  const [tab,            setTab]            = useState("pending");
  const [authorKeyPair,  setAuthorKeyPair]  = useState(null);
  const [authorPubKeyHex,setAuthorPubKeyHex]= useState(null);

  const connect = async () => {
    setConnecting(true);
    setAuthErr(null);
    try {
      if (!window.ethereum) throw new Error("MetaMask not installed.");
      const accounts   = await window.ethereum.request({ method: "eth_requestAccounts" });
      const acc        = accounts[0];
      const raw        = await ethCall(SEL_AUTHOR);
      const authorAddr = "0x" + raw.slice(-40);
      if (acc.toLowerCase() !== authorAddr.toLowerCase()) {
        setAuthErr(
          `Wrong wallet. Author is ${shorten(authorAddr, 8, 6)} — you connected ${shorten(acc, 8, 6)}.`
        );
        return;
      }
      setAccount(acc);
      try {
        const kp     = await deriveAuthorKeyPair(acc);
        const pubHex = "0x" + Array.from(kp.publicKey, b => b.toString(16).padStart(2, "0")).join("");
        setAuthorKeyPair(kp);
        setAuthorPubKeyHex(pubHex);
      } catch { /* user rejected signing — panel still works, shipping just won't decrypt */ }
    } catch (e) {
      setAuthErr(e.message || "Connection failed.");
    } finally {
      setConnecting(false);
    }
  };

  const loadOrders = useCallback(async () => {
    if (!account) return;
    setLoading(true);
    setLogErr(null);
    try {
      const logs  = await ethLogs();
      const items = await Promise.all(
        logs.map(async log => {
          const base = parseCreatedLog(log);
          try {
            const raw = await ethCall(SEL_GET_ORDER + pad32(base.id));
            const d   = decodeOrder(raw);
            if (!d || d.buyer === "0x" + "0".repeat(40)) return null;
            return { ...base, ...d };
          } catch { return null; }
        })
      );
      setOrders(items.filter(Boolean).sort((a, b) => b.createdAt - a.createdAt));
    } catch (e) {
      setLogErr(e.message || "Could not load orders.");
    } finally {
      setLoading(false);
    }
  }, [account]);

  useEffect(() => { loadOrders(); }, [loadOrders]);

  // Merge a manually-looked-up order into the list
  const mergeOrder = (order) => {
    setOrders(prev => {
      const without = prev.filter(o => o.id !== order.id);
      return [order, ...without];
    });
  };

  const groups = {
    pending: orders.filter(o => o.status === 0),
    ready:   orders.filter(o => o.status === 1 &&  windowLeft(o.fulfilledAt)?.expired),
    window:  orders.filter(o => o.status === 1 && !windowLeft(o.fulfilledAt)?.expired),
    done:    orders.filter(o => o.status === 2 || o.status === 3),
  };

  const TABS = [
    { k: "pending", label: "Needs Fulfillment", urgent: groups.pending.length > 0 },
    { k: "ready",   label: "Release Profit",    urgent: groups.ready.length  > 0 },
    { k: "window",  label: "Dispute Window" },
    { k: "done",    label: "Done" },
  ];

  const shown = groups[tab] ?? [];

  const handleSign = async () => {
    try {
      const kp     = await deriveAuthorKeyPair(account);
      const pubHex = "0x" + Array.from(kp.publicKey, b => b.toString(16).padStart(2, "0")).join("");
      setAuthorKeyPair(kp);
      setAuthorPubKeyHex(pubHex);
    } catch {}
  };

  return (
    <div className="admin-shell">

      <header className="admin-hdr">
        <div className="admin-hdr-inner">
          <div>
            <div className="eyebrow" style={{ color: "var(--accent)", marginBottom: 4 }}>
              ⬡ Author Admin · BookEscrow
            </div>
            <h1 className="admin-title">Escrow Dashboard</h1>
          </div>
          {account && (
            <div className="admin-wallet">
              <span className="dapp-eyebrow">Author wallet</span>
              <CopyChip value={account} label="author wallet">
                <code>{shorten(account)}</code>
              </CopyChip>
              <a
                className="dapp-link"
                href={EXPLORER_ADDR + ESCROW_ADDR}
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: 12 }}
              >
                Contract ↗
              </a>
            </div>
          )}
        </div>
      </header>

      <main className="admin-content">

        {!account ? (
          <div className="admin-gate">
            <div className="dapp-eyebrow">Authentication</div>
            <h2 className="dapp-h">Connect the <em>author wallet</em>.</h2>
            <p className="dapp-sub">
              Your identity is verified on-chain against the <code>author</code> address stored
              in the escrow contract. No passwords — only your wallet.
            </p>
            <button className="btn btn-primary" onClick={connect} disabled={connecting}>
              {connecting
                ? "Connecting…"
                : <>Connect MetaMask <span className="btn-arrow">→</span></>
              }
            </button>
            {authErr && <p className="admin-gate-err">{authErr}</p>}
            <p className="dapp-fineprint" style={{ marginTop: 24 }}>
              Contract:{" "}
              <a className="dapp-link" href={EXPLORER_ADDR + ESCROW_ADDR} target="_blank" rel="noreferrer">
                {shorten(ESCROW_ADDR, 8, 6)} ↗
              </a>
            </p>
          </div>

        ) : (
          <>
            {!authorKeyPair && (
              <div className="admin-setup-banner" style={{ marginBottom: 20 }}>
                <strong>Shipping decryption locked.</strong> The MetaMask signing prompt was skipped during connect — approve it now to decrypt shipping addresses.
                <button className="btn" style={{ alignSelf: "flex-start" }} onClick={handleSign}>
                  Sign to unlock →
                </button>
              </div>
            )}

            <div className="admin-tabs">
              {TABS.map(t => (
                <button
                  key={t.k}
                  className={`admin-tab ${tab === t.k ? "is-active" : ""} ${t.urgent ? "is-urgent" : ""}`}
                  onClick={() => setTab(t.k)}
                >
                  <em>{groups[t.k].length}</em>
                  {t.label}
                  {t.urgent && <span className="admin-dot" aria-hidden="true" />}
                </button>
              ))}
              <button className="btn admin-refresh" onClick={loadOrders} disabled={loading}>
                {loading ? "↻" : "↻ Refresh"}
              </button>
            </div>

            {logErr && (
              <div className="admin-bscscan-err">
                <p className="admin-gate-err" style={{ margin: 0 }}>{logErr}</p>
                <ManualLookup account={account} onFound={mergeOrder} />
              </div>
            )}

            {loading  && shown.length === 0 && <p className="admin-empty">Loading orders from chain…</p>}
            {!loading && shown.length === 0 && !logErr && <p className="admin-empty">No orders in this category.</p>}

            {!AUTHOR_SHIPPING_PUBKEY_CONFIGURED && authorPubKeyHex && (
              <div className="admin-setup-banner">
                <strong>One-time setup:</strong> Add this to your <code>.env</code> so buyers can encrypt their shipping address to you, then rebuild and redeploy.
                <CopyChip value={`VITE_AUTHOR_SHIPPING_PUBKEY=${authorPubKeyHex}`} label="env var">
                  <code style={{ fontSize: 11, wordBreak: "break-all" }}>VITE_AUTHOR_SHIPPING_PUBKEY={shorten(authorPubKeyHex, 14, 12)}</code>
                </CopyChip>
              </div>
            )}

            <div className="admin-grid">
              {shown.map(o => (
                <OrderCard
                  key={o.id}
                  order={o}
                  account={account}
                  authorKeyPair={authorKeyPair}
                  onSign={handleSign}
                  onRefresh={loadOrders}
                />
              ))}
            </div>
          </>
        )}

      </main>
    </div>
  );
}
