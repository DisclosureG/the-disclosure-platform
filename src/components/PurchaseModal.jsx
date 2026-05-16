import { useState, useEffect, useMemo } from 'react';
import nacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from 'tweetnacl-util';

const ESCROW_ADDR  = import.meta.env.VITE_ESCROW_ADDR ?? "0x194Cb87E06cEf23Cd6f37Ef83C27761b07490C44";
const DOGE_BEP20   = import.meta.env.VITE_DOGE_ADDR   ?? "0xf328840bAdbAd51a207f2A6618D75567F2dEEc07";
const PEPE_BEP20   = import.meta.env.VITE_PEPE_ADDR   ?? "0xb642364705c6e009299d32eba9Abbcb54e197065";
const DISPUTE_DAYS = 99;
const PRICE_USD    = 420.69;
const COST_RATIO   = 0.7606;   // $320 book + shipping
const PROFIT_RATIO = 0.2394;   // $100.69 escrowed profit
const LS_SESSION   = "ip.session.v1";
const LS_ORDERS    = "ip.orders.v1";
const AUTHOR_SHIPPING_PUBKEY = import.meta.env.VITE_AUTHOR_SHIPPING_PUBKEY ?? null;

// Chain: set VITE_CHAIN_ID in .env to override.
// 0x38 = BSC mainnet, 0x61 = BSC testnet, 0x7a69 = Hardhat local
const CHAIN_ID = import.meta.env.VITE_CHAIN_ID ?? "0x38";

const CHAIN_CONFIG = CHAIN_ID === "0x7a69"
  ? { chainId: "0x7a69", chainName: "Hardhat Local",
      nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
      rpcUrls: ["http://127.0.0.1:8545"] }
  : CHAIN_ID === "0x61"
  ? { chainId: "0x61", chainName: "BSC Testnet",
      nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
      rpcUrls: ["https://bsc-testnet-rpc.publicnode.com"],
      blockExplorerUrls: ["https://testnet.bscscan.com"] }
  : { chainId: "0x38", chainName: "BNB Smart Chain",
      nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
      rpcUrls: ["https://bsc-dataseed.binance.org"],
      blockExplorerUrls: ["https://bscscan.com"] };

const EXPLORER_TX   = CHAIN_ID === "0x61" ? "https://testnet.bscscan.com/tx/"      : "https://bscscan.com/tx/";
const EXPLORER_ADDR = CHAIN_ID === "0x61" ? "https://testnet.bscscan.com/address/" : "https://bscscan.com/address/";

/* ── ABI helpers (no ethers dep) ─────────────────────────────────── */

function pad32(val) {
  if (val == null) return "0".repeat(64);
  const hex = typeof val === "bigint" ? val.toString(16) : String(val).replace(/^0x/i, "");
  return hex.toLowerCase().padStart(64, "0");
}
function encodeApprove(spender, amountWei) {
  // approve(address,uint256) = 0x095ea7b3
  return "0x095ea7b3" + pad32(spender) + pad32(amountWei);
}
function encodeCreateOrder(id, token, costWei, profitWei, buyerPubKey, encryptedShippingJson) {
  // createOrder(bytes32,address,uint256,uint256,bytes32) = 0xe96aeb5b
  // Extra bytes appended after the 5 params are ignored by the contract but preserved in tx calldata.
  let data = "0xe96aeb5b" + pad32(id) + pad32(token) + pad32(costWei) + pad32(profitWei) + pad32(buyerPubKey);
  if (encryptedShippingJson) {
    data += Array.from(new TextEncoder().encode(encryptedShippingJson), b => b.toString(16).padStart(2, "0")).join("");
  }
  return data;
}
function encryptShippingForAuthor(shippingText, authorPubKeyHex) {
  const authorPubKey = new Uint8Array(authorPubKeyHex.slice(2).match(/.{2}/g).map(b => parseInt(b, 16)));
  const ephemKP = nacl.box.keyPair();
  const nonce   = nacl.randomBytes(nacl.box.nonceLength);
  const box     = nacl.box(new TextEncoder().encode(shippingText), nonce, authorPubKey, ephemKP.secretKey);
  return JSON.stringify({
    version:        "x25519-xsalsa20-poly1305",
    nonce:          encodeBase64(nonce),
    ephemPublicKey: encodeBase64(ephemKP.publicKey),
    ciphertext:     encodeBase64(box),
  });
}
// Deterministic message the buyer signs to derive their nacl keypair.
// personal_sign is available in every MetaMask version; eth_getEncryptionPublicKey was removed in v12.
function trackingSignMessage(orderId) {
  const text = `Sign to receive your shipping tracking number privately.\nOnly your wallet will be able to read it — nothing is sent or broadcast.\n\nOrder: ${orderId}`;
  return "0x" + Array.from(new TextEncoder().encode(text), b => b.toString(16).padStart(2, "0")).join("");
}

// Sign → HKDF-SHA-256 → 32-byte nacl box secret key.
// The same account + orderId always produces the same keypair (RFC-6979 k).
async function deriveTrackingKeyPair(orderId, account) {
  const sig = await window.ethereum.request({
    method: "personal_sign",
    params: [trackingSignMessage(orderId), account],
  });
  const sigBytes = new Uint8Array(sig.slice(2).match(/.{2}/g).map(b => parseInt(b, 16)));
  const km = await crypto.subtle.importKey("raw", sigBytes, { name: "HKDF" }, false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256",
      salt: new TextEncoder().encode("nacl-box-key-v1"),
      info: new TextEncoder().encode("tracking") },
    km, 256,
  );
  return nacl.box.keyPair.fromSecretKey(new Uint8Array(bits));
}

// nacl Uint8Array pubkey → "0x" + 64 hex chars (bytes32 on-chain)
function naclPubKeyToBytes32(pubKey) {
  return "0x" + Array.from(pubKey, b => b.toString(16).padStart(2, "0")).join("");
}

// Read encrypted tracking bytes from the contract via eth_call
async function fetchEncryptedTracking(orderId) {
  // encryptedTrackings(bytes32) = 0x751947c1
  const raw = await window.ethereum.request({
    method: "eth_call",
    params: [{ to: ESCROW_ADDR, data: "0x751947c1" + pad32(orderId) }, "latest"],
  });
  // ABI decode: offset (32) + length (32) + data
  const d = raw.slice(2);
  if (d.length < 128) return null;
  const len = parseInt(d.slice(64, 128), 16);
  if (len === 0) return null;
  return d.slice(128, 128 + len * 2);
}
// Read live order status from contract
async function fetchOrderStatus(orderId) {
  // getOrder(bytes32) = 0x5778472a
  const raw = await window.ethereum.request({
    method: "eth_call",
    params: [{ to: ESCROW_ADDR, data: "0x5778472a" + pad32(orderId) }, "latest"],
  });
  const d = raw.slice(2);
  if (d.length < 576) return null;
  const s = i => d.slice(i * 64, (i + 1) * 64);
  return {
    fulfilledAt: Number(BigInt("0x" + s(5))),
    status:      Number(BigInt("0x" + s(8))), // slot 8 now (buyerPubKey added at slot 7)
  };
}
function toWei(amount, decimals) {
  const fixed = Number(amount).toFixed(decimals);
  const [int, frac = ""] = fixed.split(".");
  return BigInt(int + frac.slice(0, decimals).padEnd(decimals, "0"));
}
function randomBytes32() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return "0x" + Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
}
async function waitForReceipt(txHash) {
  for (;;) {
    await new Promise(r => setTimeout(r, 1500));
    const receipt = await window.ethereum.request({ method: "eth_getTransactionReceipt", params: [txHash] });
    if (receipt) {
      if (receipt.status === "0x0") throw new Error("Transaction reverted on-chain.");
      return receipt;
    }
  }
}

/* ── Persistence ────────────────────────────────────────────────── */

function loadJSON(k, fallback) {
  try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
function loadOrders(account) {
  const all = loadJSON(LS_ORDERS, {});
  return account ? (all[account.toLowerCase()] || []) : [];
}
function appendOrder(account, ord) {
  const all = loadJSON(LS_ORDERS, {});
  const k = account.toLowerCase();
  all[k] = [...(all[k] || []), ord];
  saveJSON(LS_ORDERS, all);
}

/* ── Formatters ─────────────────────────────────────────────────── */

function shorten(addr, l = 6, r = 4) {
  if (!addr) return "";
  return addr.slice(0, l) + "…" + addr.slice(-r);
}
function fmt(n, d = 0) {
  return Number(n).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
}

/* ── Shared UI ──────────────────────────────────────────────────── */

function CopyChip({ value, children, label }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={`copy-chip ${copied ? "is-copied" : ""}`}
      aria-label={`Copy ${label}`}
      onClick={async (e) => {
        e.stopPropagation();
        try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch {}
      }}
    >
      <span>{children ?? value}</span>
      <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
        {copied ? (
          <path d="M5 13l4 4L19 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
        ) : (
          <g fill="none" stroke="currentColor" strokeWidth="1.6">
            <rect x="9" y="9" width="11" height="11" rx="2"/>
            <path d="M5 15V5a1 1 0 0 1 1-1h10"/>
          </g>
        )}
      </svg>
    </button>
  );
}

function CoinGlyph({ kind, size = 28 }) {
  const src = kind === "doge" ? "/artefacts/doge-logo.svg" : "/artefacts/pepe-logo.svg";
  const alt = kind === "doge" ? "Dogecoin" : "Pepe";
  return <img src={src} width={size} height={size} alt={alt} style={{ display: "block", objectFit: "contain" }} />;
}

function tokenName(id) {
  return id === "doge" ? "Dogecoin" : "Pepe";
}

const WALLETS = [
  { id: "metamask", name: "MetaMask", blurb: "BNB Smart Chain" },
];

function isMobile() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function metamaskDeepLink() {
  const host = window.location.host + window.location.pathname;
  return `https://metamask.app.link/dapp/${host}`;
}

function WalletIcon({ id, size = 22 }) {
  if (id === "metamask") return (
    <img src="/artefacts/metamask-fox.png" width={size} height={size} alt="MetaMask" style={{ display: "block", objectFit: "contain" }} />
  );
}

const STEPS = [
  { id: "connect", label: "Connect" },
  { id: "order",   label: "Order"   },
  { id: "pay",     label: "Pay"     },
  { id: "track",   label: "Track"   },
];

function Stepper({ current, onJump, reachable }) {
  const idx = STEPS.findIndex((s) => s.id === current);
  return (
    <ol className="dapp-stepper" aria-label="Checkout progress">
      {STEPS.map((s, i) => {
        const can = reachable ? reachable(s.id) : false;
        const cls = `dapp-step ${i < idx ? "is-done" : ""} ${i === idx ? "is-current" : ""} ${can ? "is-clickable" : ""}`;
        return (
          <li key={s.id} className="dapp-step-item">
            <button
              type="button"
              className={cls}
              onClick={() => { if (can && onJump) onJump(s.id); }}
              disabled={!can}
            >
              <span className="dapp-step-num">{String(i + 1).padStart(2, "0")}</span>
              <span className="dapp-step-label">{s.label}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/* ── Step 01: Connect ───────────────────────────────────────────── */

function ConnectStep({ onConnect }) {
  const [pending, setPending] = useState(null);
  const [error, setError] = useState(null);
  const mobile = isMobile();
  const hasProvider = !!window.ethereum;

  const connectMetaMask = async () => {
    setPending("metamask");
    setError(null);
    try {
      const provider = window.ethereum;
      if (!provider?.isMetaMask) throw new Error("MetaMask not installed.");
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      const account  = accounts[0];
      const current  = await provider.request({ method: "eth_chainId" });
      if (current.toLowerCase() !== CHAIN_ID.toLowerCase()) {
        try {
          await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_ID }] });
        } catch (switchErr) {
          if (switchErr.code === 4902) {
            await provider.request({ method: "wallet_addEthereumChain", params: [CHAIN_CONFIG] });
          } else throw switchErr;
        }
      }
      const sess = { wallet: "metamask", account };
      saveJSON(LS_SESSION, sess);
      onConnect(sess);
    } catch (err) {
      setError(err.code === 4001 ? "Connection rejected." : (err.message || "Connection failed."));
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="dapp-pane">
      <div className="dapp-eyebrow">Step 01 · Wallet</div>
      <h3 className="dapp-h">Connect wallet on <em style={{ color: "#F3BA2F" }}>BNB Smart Chain</em>.</h3>
      <p className="dapp-sub">
        The escrow contract lives on BNB Smart Chain. You will hold the keys throughout — neither this site
        nor the author can move funds out of escrow on your behalf.
      </p>
      <div className="wallet-grid">
        {mobile && !hasProvider ? (
          <a
            className="wallet-tile"
            href={metamaskDeepLink()}
          >
            <span className="wallet-tile-icon"><WalletIcon id="metamask" size={32} /></span>
            <span className="wallet-tile-body">
              <strong>Open in MetaMask app</strong>
              <small>Tap to open this page in MetaMask's browser</small>
            </span>
            <span className="wallet-tile-arrow">→</span>
          </a>
        ) : (
          WALLETS.map((w) => (
            <button
              key={w.id}
              className={`wallet-tile ${pending === w.id ? "is-pending" : ""}`}
              onClick={connectMetaMask}
              disabled={!!pending}
            >
              <span className="wallet-tile-icon"><WalletIcon id={w.id} size={32} /></span>
              <span className="wallet-tile-body">
                <strong>{w.name}</strong>
                <small>{mobile ? "MetaMask mobile · BNB Smart Chain" : "Browser extension · BNB Smart Chain"}</small>
              </span>
              <span className="wallet-tile-arrow">
                {pending === w.id ? <span className="spin">◐</span> : "→"}
              </span>
            </button>
          ))
        )}
      </div>
      {error && <p className="dapp-error" style={{ color: "var(--warn, #f87171)", marginTop: 12, fontSize: "0.85rem" }}>{error}</p>}
      <div className="dapp-fineprint">
        <p className="dapp-fineprint-row">
          <span className="dapp-fineprint-k">Network</span>
          <span className="dapp-fineprint-v">BNB Smart Chain · Chain {parseInt(CHAIN_ID, 16)}</span>
        </p>
        <p>Contract: <a className="dapp-link" href={EXPLORER_ADDR + ESCROW_ADDR} target="_blank" rel="noreferrer">
          {shorten(ESCROW_ADDR, 8, 6)} ↗
        </a></p>
      </div>
      <p className="no-login-note">
        <strong>No login.</strong> No password. Your wallet <em>is</em> your account —
        come back any time, reconnect, and your orders are still here.
      </p>
    </div>
  );
}

/* ── Step 02: Order ─────────────────────────────────────────────── */

function OrderStep({ session, prices, onBack, onConfirm }) {
  const [token, setToken] = useState("doge");
  const [shipping, setShipping] = useState("");
  const [bookId]  = useState(() => "BOOK-" + Math.random().toString(36).slice(2, 6).toUpperCase());
  const [orderId] = useState(randomBytes32);   // generated once; stays stable across re-renders
  const [pubKey, setPubKey]   = useState(null);
  const [signing, setSigning] = useState(false);
  const [keyErr, setKeyErr]   = useState(null);

  const amount = useMemo(() => {
    if (token === "doge" && prices.doge) return (PRICE_USD / prices.doge);
    if (token === "pepe" && prices.pepe) return (PRICE_USD / prices.pepe);
    return null;
  }, [token, prices]);

  return (
    <div className="dapp-pane">
      <div className="dapp-eyebrow">Step 02 · Order</div>
      <h3 className="dapp-h">Pick your meme · enter shipping.</h3>

      <div className="account-strip">
        <span className="dapp-eyebrow">Connected</span>
        <CopyChip value={session.account} label="wallet"><code>{shorten(session.account, 6, 4)}</code></CopyChip>
      </div>

      <div className="refund-strip">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none"
             stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 5 5v0a5 5 0 0 1-5 5H8"/>
        </svg>
        <div>
          <strong>You can refund yourself.</strong>
          <small>If the book disappoints, click once and ${(PRICE_USD * PROFIT_RATIO).toFixed(2)} comes back to this wallet — for {DISPUTE_DAYS} days, no questions asked.</small>
        </div>
      </div>

      <div className="token-row">
        {[
          { id: "doge", name: "Dogecoin", sub: "on BNB Smart Chain" },
          { id: "pepe", name: "Pepe",     sub: "on BNB Smart Chain" },
        ].map((t) => {
          const active = token === t.id;
          const a = t.id === "doge" ? (prices.doge ? PRICE_USD / prices.doge : null)
                                    : (prices.pepe ? PRICE_USD / prices.pepe : null);
          return (
            <button
              key={t.id}
              className={`token-card ${active ? "is-active" : ""}`}
              onClick={() => setToken(t.id)}
              aria-pressed={active}
            >
              <CoinGlyph kind={t.id} />
              <div className="token-card-body">
                <strong>{t.name}</strong>
                <small>{t.sub}</small>
              </div>
              <div className="token-card-amt">
                <em>{a == null ? "…" : t.id === "doge" ? fmt(a, 2) : fmt(Math.round(a))}</em>
                <small>{tokenName(t.id)}</small>
              </div>
            </button>
          );
        })}
      </div>

      <label className="dapp-field">
        <span className="dapp-eyebrow">Shipping address (off-chain)</span>
        <textarea
          rows={3}
          placeholder={"Recipient name\nStreet, city, postcode\nCountry"}
          value={shipping}
          onChange={(e) => setShipping(e.target.value)}
        />
        <small className="dapp-fineprint">
          Encrypted in the order metadata · only the author can decrypt.
        </small>
      </label>

      <div className="order-summary">
        <div className="row"><span>Book</span><strong>A Multiverse of Love</strong></div>
        <div className="row"><span>Sale price</span><strong>${PRICE_USD} <small>USD</small></strong></div>
        <div className="row split"><span>↳ Cost · print + ship</span><em>${(PRICE_USD * COST_RATIO).toFixed(2)} <small>(released on fulfillment)</small></em></div>
        <div className="row split"><span>↳ Profit · escrowed {DISPUTE_DAYS} days</span><em>${(PRICE_USD * PROFIT_RATIO).toFixed(2)} <small>(refundable by you)</small></em></div>
        <div className="row total">
          <span>Pay to escrow</span>
          <strong>
            {amount == null ? "…" : token === "doge" ? fmt(amount, 2) : fmt(Math.round(amount))}
            <small> {tokenName(token)}</small>
          </strong>
        </div>
      </div>

      <div className="encrypt-key-strip">
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none"
             stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        </svg>
        <div>
          <strong>Encrypted tracking delivery.</strong>
          <small>
            {pubKey
              ? "Signed — your tracking number will only be readable by this wallet."
              : "Sign once with MetaMask so the tracking number can be encrypted on-chain for your wallet only."}
          </small>
        </div>
        {!pubKey && (
          <button
            className="btn"
            style={{ flexShrink: 0 }}
            disabled={signing}
            onClick={async () => {
              setKeyErr(null);
              setSigning(true);
              try {
                const kp = await deriveTrackingKeyPair(orderId, session.account);
                setPubKey(naclPubKeyToBytes32(kp.publicKey));
              } catch (e) {
                if (e.code !== 4001) setKeyErr("Signing failed — try again.");
              } finally {
                setSigning(false);
              }
            }}
          >
            {signing ? "Waiting…" : "Sign →"}
          </button>
        )}
        {pubKey && <span className="encrypt-check">✓</span>}
        {keyErr && <small style={{ color: "var(--warn, #f87171)" }}>{keyErr}</small>}
      </div>

      <div className="dapp-actions">
        <button className="btn" onClick={onBack}>← Back</button>
        <button
          className="btn btn-primary"
          disabled={!amount || !pubKey}
          onClick={() => onConfirm({ token, amount, shipping, bookId, orderId, buyerPubKey: pubKey })}
        >
          Review payment <span className="btn-arrow">→</span>
        </button>
      </div>
    </div>
  );
}

/* ── Step 03: Pay ───────────────────────────────────────────────── */

const TX_PHASES = [
  { k: "approve",   label: "Approve token — confirm in MetaMask" },
  { k: "approving", label: "Waiting for approval on-chain…" },
  { k: "create",    label: "Create order — confirm in MetaMask" },
  { k: "mining",    label: "Confirming order on-chain…" },

];
const TX_KEYS = TX_PHASES.map(p => p.k);

function PayStep({ session, order, onBack, onPaid }) {
  const [phase, setPhase] = useState("idle");
  const [hash, setHash] = useState(null);
  const [error, setError] = useState(null);
  const [gasFee, setGasFee] = useState(null);

  useEffect(() => {
    const provider = window.ethereum;
    if (!provider) return;
    provider.request({ method: "eth_gasPrice" })
      .then(hex => {
        const feeWei = BigInt(hex) * 200000n;
        setGasFee((Number(feeWei) / 1e18).toFixed(4));
      })
      .catch(() => {});
  }, []);
  const submit = async () => {
    setError(null);
    const provider = window.ethereum;
    if (!provider) { setError("MetaMask not connected."); return; }

    let encryptedShipping = null;
    if (order.shipping?.trim() && AUTHOR_SHIPPING_PUBKEY) {
      try {
        encryptedShipping = encryptShippingForAuthor(order.shipping.trim(), AUTHOR_SHIPPING_PUBKEY);
      } catch (e) {
        // encryption failure is non-fatal — order proceeds without shipping data
      }
    }

    try {
      const tokenAddr = order.token === "doge" ? DOGE_BEP20 : PEPE_BEP20;
      const decimals  = order.token === "doge" ? 8 : 18;
      const totalWei  = toWei(order.amount, decimals);
      const costWei   = totalWei * 32000n / 42069n; // $320 of $420.69
      const profitWei = totalWei - costWei;
      // orderId was generated in OrderStep and signed over; don't generate a new one here.
      const orderId   = order.orderId ?? randomBytes32();

      // Tx 1: approve token spend
      setPhase("approve");
      const approveTx = await provider.request({
        method: "eth_sendTransaction",
        params: [{ from: session.account, to: tokenAddr, data: encodeApprove(ESCROW_ADDR, totalWei) }],
      });

      setPhase("approving");
      await waitForReceipt(approveTx);

      // Tx 2: createOrder
      setPhase("create");
      const orderTx = await provider.request({
        method: "eth_sendTransaction",
        params: [{ from: session.account, to: ESCROW_ADDR, data: encodeCreateOrder(orderId, tokenAddr, costWei, profitWei, order.buyerPubKey, encryptedShipping) }],
      });
      setHash(orderTx);

      setPhase("mining");
      await waitForReceipt(orderTx);

      setPhase("done");
      setTimeout(() => onPaid(orderTx, orderId), 600);
    } catch (err) {
      setError(err.code === 4001 ? "Rejected — no funds moved." : (err.message || "Transaction failed."));
      setPhase("idle");
    }
  };

  const tokenAddr = order.token === "doge" ? DOGE_BEP20 : PEPE_BEP20;
  const amtStr    = order.token === "doge" ? fmt(order.amount, 2) : fmt(Math.round(order.amount));

  return (
    <div className="dapp-pane">
      <div className="dapp-eyebrow">Step 03 · Sign</div>
      <h3 className="dapp-h">Send <em>{amtStr} {tokenName(order.token)}</em> to the escrow.</h3>

      <div className="tx-card">
        <div className="tx-row"><span>From</span><CopyChip value={session.account} label="from"><code>{shorten(session.account)}</code></CopyChip></div>
        <div className="tx-row"><span>To · escrow</span><CopyChip value={ESCROW_ADDR} label="escrow"><code>{shorten(ESCROW_ADDR)}</code></CopyChip></div>
        <div className="tx-row"><span>Token</span><CopyChip value={tokenAddr} label="token"><code>{tokenName(order.token)} · {shorten(tokenAddr, 6, 4)}</code></CopyChip></div>
        <div className="tx-row"><span>Amount</span><strong>{amtStr} <small>{tokenName(order.token)}</small></strong></div>
        <div className="tx-row"><span>Transactions</span><span>2 × MetaMask confirmations</span></div>
        <div className="tx-row"><span>Network fee (est.)</span><span>~ {gasFee ?? "0.0009"} BNB per transaction</span></div>
      </div>


      <div className="tx-status">
        {TX_PHASES.map((s) => {
          const si    = TX_KEYS.indexOf(s.k);
          const ci    = TX_KEYS.indexOf(phase);
          const state = phase === "idle" ? "wait" : si < ci ? "ok" : si === ci ? "live" : "wait";
          return (
            <div key={s.k} className={`tx-step is-${state}`}>
              <span className="tx-step-dot">
                {state === "ok" ? "✓" : state === "live" ? <span className="spin">◐</span> : ""}
              </span>
              <span>{s.label}</span>
            </div>
          );
        })}
      </div>

      {error && (
        <p style={{ color: "var(--warn, #f87171)", marginTop: 10, fontSize: "0.85rem" }}>{error}</p>
      )}
      {hash && (
        <p className="dapp-fineprint" style={{ marginTop: 14 }}>
          Tx:{" "}
          <a className="dapp-link" href={EXPLORER_TX + hash} target="_blank" rel="noreferrer">
            {shorten(hash, 10, 8)} ↗
          </a>
        </p>
      )}

      <div className="dapp-actions">
        <button className="btn" onClick={onBack} disabled={phase !== "idle"}>← Back</button>
        <button className="btn btn-primary" onClick={submit} disabled={phase !== "idle"}>
          {phase === "idle" ? <>Sign transactions <span className="btn-arrow">→</span></> : "Submitting…"}
        </button>
      </div>
    </div>
  );
}

/* ── Step 04: Track ─────────────────────────────────────────────── */

function TrackStep({ session, order, hash, onBack, onNew, onClose }) {
  const [liveStatus,   setLiveStatus]   = useState(null);  // null = loading
  const [trackingNum,  setTrackingNum]  = useState(null);
  const [decrypting,   setDecrypting]   = useState(false);
  const [decryptErr,   setDecryptErr]   = useState(null);
  const [claiming,     setClaiming]     = useState(false);
  const [claimErr,     setClaimErr]     = useState(null);

  // Poll the contract for real status every 30 s
  useEffect(() => {
    if (!order.orderId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const s = await fetchOrderStatus(order.orderId);
        if (!cancelled && s) setLiveStatus(s);
      } catch {}
    };
    poll();
    const t = setInterval(poll, 30000);
    return () => { cancelled = true; clearInterval(t); };
  }, [order.orderId]);

  const contractStatus = liveStatus?.status ?? null;
  const fulfilledAt    = liveStatus?.fulfilledAt ?? 0;

  const windowEndMs = fulfilledAt ? (fulfilledAt + DISPUTE_DAYS * 86400) * 1000 : 0;
  const msLeft      = windowEndMs ? Math.max(0, windowEndMs - Date.now()) : 0;
  const daysLeft    = Math.floor(msLeft / 86400000);
  const windowOpen  = msLeft > 0;

  // Map contract status to lifecycle stage index
  // 0=Paid → stage 0, 1=Fulfilled+window open → stage 2, 1=Fulfilled+closed/2=Released/3=Refunded → stage 3
  const stage = contractStatus === null ? null
    : contractStatus === 0 ? 0
    : contractStatus === 1 && windowOpen ? 2
    : 3;

  const stages = [
    { k: 0, label: "Payment received",  sub: "Funds locked in escrow contract." },
    { k: 1, label: "Order fulfilled",   sub: "Tracking number encrypted on-chain." },
    { k: 2, label: "Dispute window",    sub: `Claim a refund.` },
    { k: 3, label: contractStatus === 3 ? "Refunded" : "Complete", sub: contractStatus === 3 ? "Profit returned to you." : "Escrow concluded." },
  ];

  const decrypt = async () => {
    setDecryptErr(null);
    setDecrypting(true);
    try {
      const hex = await fetchEncryptedTracking(order.orderId);
      if (!hex) { setDecryptErr("No tracking data on-chain yet — the author hasn't shipped yet."); return; }

      const bytes   = hex.match(/.{2}/g).map(b => parseInt(b, 16));
      const jsonStr = new TextDecoder().decode(new Uint8Array(bytes));

      let parsed;
      try { parsed = JSON.parse(jsonStr); } catch {
        setDecryptErr("Tracking data on-chain is unreadable — contact the author.");
        return;
      }

      // Plaintext fallback — used when the buyer had no pubkey at order time.
      if (parsed.version === "plaintext") {
        setTrackingNum(parsed.tracking);
        return;
      }

      if (parsed.version !== "x25519-xsalsa20-poly1305") {
        setDecryptErr("Unknown tracking format — contact the author for your tracking number.");
        return;
      }

      const [currentAccount] = await window.ethereum.request({ method: "eth_accounts" });
      const account = currentAccount ?? session.account;

      // Re-derive the same nacl keypair by signing the same deterministic message used at order time.
      // personal_sign is deterministic (RFC-6979), so the same wallet always gives the same key.
      const kp = await deriveTrackingKeyPair(order.orderId, account);

      const decrypted = nacl.box.open(
        decodeBase64(parsed.ciphertext),
        decodeBase64(parsed.nonce),
        decodeBase64(parsed.ephemPublicKey),
        kp.secretKey,
      );

      if (!decrypted) {
        setDecryptErr("Decryption failed — make sure you're using the same wallet you ordered with.");
        return;
      }
      setTrackingNum(new TextDecoder().decode(decrypted));
    } catch (e) {
      if (e.code === 4001) {
        setDecryptErr("Cancelled — click 'Reveal tracking' to try again.");
      } else {
        setDecryptErr(e.message || "Decryption failed.");
      }
    } finally {
      setDecrypting(false);
    }
  };

  const claimRefund = async () => {
    setClaimErr(null);
    setClaiming("confirm");
    try {
      // claimProfitRefund(bytes32) = 0xb9b35088
      const data = "0xb9b35088" + pad32(order.orderId);
      const txHash = await window.ethereum.request({
        method: "eth_sendTransaction",
        params: [{ from: session.account, to: ESCROW_ADDR, data, gas: "0x30D40" }],
      });
      setClaiming("mining");
      await waitForReceipt(txHash);
      const updated = await fetchOrderStatus(order.orderId);
      if (updated) setLiveStatus(updated);
    } catch (e) {
      if (e.code !== 4001) setClaimErr(e.message || "Transaction failed.");
    } finally {
      setClaiming(false);
    }
  };

  const displayId = order.orderId ? shorten(order.orderId, 8, 6) : "—";

  return (
    <div className="dapp-pane">
      <div className="dapp-eyebrow">Step 04 · On-chain</div>
      <h3 className="dapp-h">Order <em>#{displayId}</em> — escrow live.</h3>

      <div className="track-grid">
        <div className="track-meta">
          <div className="row"><span>Buyer</span><CopyChip value={session.account} label="buyer"><code>{shorten(session.account)}</code></CopyChip></div>
          <div className="row"><span>Token</span><strong>{tokenName(order.token)}</strong></div>
          <div className="row"><span>Paid</span>
            <strong>
              {order.token === "doge" ? fmt(order.amount, 2) : fmt(Math.round(order.amount))} {tokenName(order.token)}
            </strong>
          </div>
          <div className="row"><span>Tx</span>
            {hash ? <a className="dapp-link" href={EXPLORER_TX + hash} target="_blank" rel="noreferrer">{shorten(hash, 8, 6)} ↗</a> : "—"}
          </div>
        </div>

        <ol className="lifecycle">
          {stage === null ? (
            <li className="life-step is-wait"><span className="life-dot" /><div><strong>Loading…</strong></div></li>
          ) : stages.map((s) => {
            const state = s.k < stage ? "ok" : s.k === stage ? "live" : "wait";
            return (
              <li key={s.k} className={`life-step is-${state}`}>
                <span className="life-dot" />
                <div>
                  <strong>{s.label}</strong>
                  <small>{s.sub}</small>
                </div>
              </li>
            );
          })}
        </ol>
      </div>

      {/* Tracking number — shown once fulfilled */}
      {contractStatus >= 1 && (
        <div className="tracking-reveal">
          {trackingNum ? (
            <div className="tracking-number">
              <div className="dapp-eyebrow" style={{ marginBottom: 6 }}>Shipping tracking number</div>
              <CopyChip value={trackingNum} label="tracking number">
                <strong style={{ fontSize: 18, letterSpacing: "0.08em" }}>{trackingNum}</strong>
              </CopyChip>
              <small className="dapp-fineprint" style={{ display: "block", marginTop: 8 }}>
                Decrypted from on-chain data — only your wallet could read this.
              </small>
            </div>
          ) : (
            <div className="tracking-locked">
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none"
                   stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2"/>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
              </svg>
              <div>
                <strong>Tracking number encrypted on-chain.</strong>
                <small>MetaMask decrypts it — only your wallet can read it, nobody else.</small>
              </div>
              <button className="btn btn-primary" onClick={decrypt} disabled={decrypting}>
                {decrypting ? "Decrypting…" : <>Reveal tracking <span className="btn-arrow">→</span></>}
              </button>
              {decryptErr && <small style={{ color: "var(--warn, #f87171)" }}>{decryptErr}</small>}
            </div>
          )}
        </div>
      )}

      {stage === 2 && (
        <div className="refund-hero">
          <div className="refund-hero-head">
            <div>
              <div className="dapp-eyebrow">Not satisfied?</div>
              <h4 className="refund-hero-title">Get the <em>profit back</em> — yourself.</h4>
              <p className="refund-hero-sub">
                You have <strong>{daysLeft} days</strong> to decide. One click sends
                ${(PRICE_USD * PROFIT_RATIO).toFixed(2)} straight back to your wallet. No emails,
                no waiting, no asking permission.
              </p>
            </div>
            <div className="refund-hero-num">
              <em>{daysLeft.toString().padStart(2, "0")}</em>
              <small>days left</small>
            </div>
          </div>
          <div className="countdown-bar">
            <div className="countdown-fill" style={{ width: `${(daysLeft / DISPUTE_DAYS) * 100}%` }} />
          </div>
          <p className="refund-hero-foot">
            Loved the book? Do nothing
          </p>
        </div>
      )}

      <div className="dapp-actions stretch">
        <button className="btn" onClick={onBack}>← Back</button>
        {stage === 2 && (
          <>
            <button className="btn btn-warn" onClick={claimRefund} disabled={!!claiming}>
              {claiming === "confirm" ? "Confirm in MetaMask…"
               : claiming === "mining" ? "Confirming on-chain…"
               : <>Claim profit refund <span className="btn-arrow">↩</span></>}
            </button>
            {claimErr && <small style={{ color: "var(--warn, #f87171)" }}>{claimErr}</small>}
          </>
        )}
        {stage === 3 && (
          <button className="btn btn-primary" onClick={onNew || onClose}>
            Order again <span className="btn-arrow">→</span>
          </button>
        )}
      </div>
    </div>
  );
}

/* ── Orders list ────────────────────────────────────────────────── */

function OrdersStep({ session, orders, onTrack, onNew, onDisconnect }) {
  return (
    <div className="dapp-pane dapp-pane--wide">
      <div className="dapp-eyebrow">Welcome back</div>
      <h3 className="dapp-h">Your orders · <em>{shorten(session.account)}</em></h3>
      <p className="dapp-sub">
        No login — your wallet remembered you. Track an existing order, or start a new one.
      </p>
      <ul className="orders-list">
        {orders.map((o, i) => {
          const amt  = o.token === "doge" ? fmt(o.amount, 2) : fmt(Math.round(o.amount));
          const date = new Date(o.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
          return (
            <li key={i} className="order-item">
              <CoinGlyph kind={o.token} size={24} />
              <div className="order-item-body">
                <strong>BOOK · A Multiverse of Love</strong>
                <small>{date} · {amt} {tokenName(o.token)}</small>
              </div>
              <button className="btn" onClick={() => onTrack(o)}>Track →</button>
            </li>
          );
        })}
      </ul>
      <div className="dapp-actions stretch">
        <button className="btn" onClick={onDisconnect}>Disconnect wallet</button>
        <button className="btn btn-primary" onClick={onNew}>Order another copy <span className="btn-arrow">→</span></button>
      </div>
    </div>
  );
}

/* ── Refund promise sidebar ─────────────────────────────────────── */

function RefundPromise() {
  const profit = (PRICE_USD * PROFIT_RATIO).toFixed(2);
  return (
    <div className="refund-promise">
      <div className="refund-badge">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none"
             stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 5 5v0a5 5 0 0 1-5 5H8"/>
        </svg>
        <span>Refund yourself · no permission</span>
      </div>
      <h4 className="refund-title">
        Don't love the book? <em>Take your money back.</em>
      </h4>
      <p className="refund-lead">
        You're not trusting us — you're{" "}
        <a
          className="math-link"
          href="/artefacts/blockchain/Bitcoin.pdf"
          target="_blank"
          rel="noopener noreferrer"
        >
          trusting math
        </a>
        . ${profit} of every order sits in a smart contract{" "}
        <strong>only you can release</strong> for {DISPUTE_DAYS} days after the book ships.
      </p>

      <div className="read-the-math">the math</div>
      <div className="citations-row">
        <a className="citation-chip" href="/artefacts/blockchain/Bitcoin.pdf" target="_blank" rel="noopener noreferrer">
          <span className="glyph">₿</span>
          <span>Bitcoin</span>
          <span className="arrow">↗</span>
        </a>
        <a className="citation-chip" href="/artefacts/blockchain/Ethereum.pdf" target="_blank" rel="noopener noreferrer">
          <span className="glyph">Ξ</span>
          <span>Ethereum</span>
          <span className="arrow">↗</span>
        </a>
      </div>

      <ol className="refund-steps">
        <li>
          <span className="refund-num">1</span>
          <div>
            <strong>You pay.</strong>
            <small>Money goes into the contract — not our wallet.</small>
          </div>
        </li>
        <li>
          <span className="refund-num">2</span>
          <div>
            <strong>Book ships.</strong>
            <small>You read it. You take {DISPUTE_DAYS} days to decide.</small>
          </div>
        </li>
        <li className="refund-step--star">
          <span className="refund-num">3</span>
          <div>
            <strong>Loved it?</strong> Do nothing.<br/>
            <strong>Didn't?</strong> One click sends ${profit} back to your wallet.
            <small>We can't stop you. The contract just does it.</small>
          </div>
        </li>
      </ol>
    </div>
  );
}

/* ── Root modal ─────────────────────────────────────────────────── */

export default function PurchaseModal({ open, onClose }) {
  const [step, setStep]           = useState("connect");
  const [session, setSession]     = useState(null);
  const [order, setOrder]         = useState(null);
  const [hash, setHash]           = useState(null);
  const [prices, setPrices]       = useState({ doge: null, pepe: null });
  const [pastOrders, setPastOrders] = useState([]);

  useEffect(() => {
    if (open) {
      const saved = loadJSON(LS_SESSION, null);
      if (saved?.account && window.ethereum) {
        window.ethereum.request({ method: "eth_accounts" })
          .then((accounts) => {
            const stillConnected = accounts.map(a => a.toLowerCase()).includes(saved.account.toLowerCase());
            if (stillConnected) {
              setSession(saved);
              const past = loadOrders(saved.account);
              setPastOrders(past);
              setStep(past.length ? "orders" : "order");
            } else {
              try { localStorage.removeItem(LS_SESSION); } catch {}
            }
          })
          .catch(() => {
            try { localStorage.removeItem(LS_SESSION); } catch {}
          });
      } else if (saved?.account) {
        // No ethereum provider — clear stale session
        try { localStorage.removeItem(LS_SESSION); } catch {}
      }
    } else {
      const t = setTimeout(() => {
        setStep("connect"); setOrder(null); setHash(null);
      }, 250);
      return () => clearTimeout(t);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("https://api.coingecko.com/api/v3/simple/price?ids=dogecoin,pepe&vs_currencies=usd")
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setPrices({ doge: d?.dogecoin?.usd ?? 0.18, pepe: d?.pepe?.usd ?? 0.0000091 });
      })
      .catch(() => setPrices({ doge: 0.18, pepe: 0.0000091 }));
    return () => { cancelled = true; };
  }, [open]);

  return (
    <>
    <div className={`modal-backdrop dapp-backdrop ${open ? "is-open" : ""}`} onClick={onClose}>
      <div className="modal dapp-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <button className="modal-close" onClick={onClose} aria-label="Close">×</button>

        <header className="dapp-head">
          <div>
            <div className="eyebrow">Trust-minimized escrow · BNB Smart Chain</div>
            <h3 className="h3" style={{ marginTop: 6 }}>Acquire <em style={{ fontStyle: 'italic', color: 'var(--accent)' }}>A Multiverse of Love</em></h3>
          </div>
          <Stepper
            current={step === "orders" ? "connect" : step}
            reachable={(id) => id === "connect"}
            onJump={(id) => {
              if (id === "connect" && session && pastOrders.length) { setStep("orders"); return; }
              setStep(id);
            }}
          />
        </header>

        <div className="dapp-body">
          {step === "connect" && (
            <>
              <ConnectStep onConnect={(s) => {
                setSession(s);
                const past = loadOrders(s.account);
                setPastOrders(past);
                setStep(past.length ? "orders" : "order");
              }} />
              <aside className="dapp-aside">
                <RefundPromise />
              </aside>
            </>
          )}
          {step === "orders" && session && (
            <OrdersStep
              session={session}
              orders={pastOrders}
              onTrack={(o) => { setOrder(o); setHash(o.hash); setStep("track"); }}
              onNew={() => setStep("order")}
              onDisconnect={() => {
                try { localStorage.removeItem(LS_SESSION); } catch {}
                setSession(null); setPastOrders([]); setStep("connect");
              }}
            />
          )}
          {step === "order" && session && (
            <OrderStep
              session={session}
              prices={prices}
              onBack={() => setStep("connect")}
              onConfirm={(o) => { setOrder(o); setStep("pay"); }}
            />
          )}
          {step === "pay" && session && order && (
            <PayStep
              session={session}
              order={order}
              onBack={() => setStep("order")}
              onPaid={(h, oid) => {
                setHash(h);
                const record = { ...order, hash: h, orderId: oid, createdAt: Date.now(), stage: 1 };
                appendOrder(session.account, record);
                setPastOrders(loadOrders(session.account));
                setStep("track");
              }}
            />
          )}
          {step === "track" && session && order && (
            <TrackStep
              session={session}
              order={order}
              hash={hash}
              onBack={() => setStep(pastOrders.length > 1 ? "orders" : "order")}
              onNew={() => { setOrder(null); setHash(null); setStep("order"); }}
              onClose={onClose}
            />
          )}
        </div>
      </div>
    </div>
</>
  );
}
