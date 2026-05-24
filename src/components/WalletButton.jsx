import { useState, useEffect } from 'react';
import { CONSENSUS_ADDR, connectWallet, switchToTargetChain, isPeerActive, getPeerHandle } from '../lib/wallet';
import { cachedAddr, cacheAddr, cachedHandle, cacheHandle, cachePeer } from '../lib/wallet-cache';
import metamaskFox from '../assets/metamask-fox.svg';

// Header connect button. Connects the wallet to the session (MetaMask grant)
// without navigating, so a user who connects here is already connected when a
// gated surface (peer review, challenge) later asks for a wallet — the grant
// persists per-origin and is silently restored via eth_accounts.

const SHORT = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const isMobile = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
const metamaskDeepLink = () => `https://metamask.app.link/dapp/${window.location.host}${window.location.pathname}`;

function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function jazzGradient(addr = '0x0') {
  const h = hashStr(String(addr).toLowerCase());
  const a = h % 360, b = (h >> 3) % 360, c = (h >> 6) % 360;
  return `conic-gradient(from ${h % 360}deg, oklch(0.72 0.14 ${a}), oklch(0.72 0.14 ${b}), oklch(0.72 0.14 ${c}), oklch(0.72 0.14 ${a}))`;
}
const Jazz = ({ addr, size = 16 }) => (
  <span className="jazz" style={{ width: size, height: size, borderRadius: '50%', background: jazzGradient(addr), flexShrink: 0 }} />
);

export default function WalletButton() {
  const [addr, setAddr] = useState(cachedAddr);
  const [handle, setHandle] = useState(() => cachedHandle(cachedAddr()));
  const [connecting, setConnecting] = useState(false);

  // Reflect the granted account, but only while a session is active — an
  // explicit disconnect (or a closed tab, which clears sessionStorage) ends the
  // session, and we must not silently reconnect from MetaMask's still-granted
  // permission. `apply` keeps state and session cache in lockstep.
  useEffect(() => {
    const apply = (a) => { setAddr(a); setHandle(a ? cachedHandle(a) : ''); cacheAddr(a); };
    const clear = () => { setAddr(null); setHandle(''); cacheAddr(null); };
    if (!window.ethereum) { clear(); return; }
    if (cachedAddr()) {
      window.ethereum.request({ method: 'eth_accounts' })
        .then(accts => apply(accts[0] || null))
        .catch(() => {});
    }
    const onAccts = (accts) => {
      const a = accts[0] || null;
      if (!a) { clear(); return; }       // disconnected in MetaMask
      if (!cachedAddr()) return;         // signed off — ignore the still-granted account
      apply(a);
    };
    window.ethereum.on?.('accountsChanged', onAccts);
    return () => window.ethereum.removeListener?.('accountsChanged', onAccts);
  }, []);

  // Resolve the verified-peer handle for the connected address so the pill can
  // show it instead of the raw address (mirrors the Peer Review header), and
  // refresh the cache for the next page load.
  useEffect(() => {
    if (!addr || !CONSENSUS_ADDR) return;
    let cancelled = false;
    (async () => {
      try {
        const peer = await isPeerActive(addr);
        const h = peer ? await getPeerHandle(addr) : '';
        if (!cancelled) setHandle(h || '');
        cacheHandle(addr, h || '');
        cachePeer(addr, { isPeer: peer });
      } catch { /* keep the cached handle */ }
    })();
    return () => { cancelled = true; };
  }, [addr]);

  const connect = async () => {
    if (!window.ethereum) { if (isMobile()) window.location.href = metamaskDeepLink(); return; }
    setConnecting(true);
    try {
      const { addr: a } = await connectWallet();
      if (CONSENSUS_ADDR) await switchToTargetChain();
      setAddr(a); cacheAddr(a);
    } catch (e) { if (e?.code !== 4001) console.warn('Wallet connect failed', e); }
    finally { setConnecting(false); }
  };

  const disconnect = () => { setAddr(null); setHandle(''); cacheAddr(null); };

  if (addr) {
    return (
      <button className="btn btn--ghost btn--sm" onClick={disconnect} title="Disconnect">
        <Jazz addr={addr} size={16} /> {handle || SHORT(addr)}
      </button>
    );
  }
  return (
    <button className="btn btn--primary btn--sm" onClick={connect} disabled={connecting}>
      <img className="wallet-icon" src={metamaskFox} alt="" width="14" height="14" aria-hidden="true" />
      {connecting ? 'Connecting…' : 'Connect wallet'}
    </button>
  );
}
