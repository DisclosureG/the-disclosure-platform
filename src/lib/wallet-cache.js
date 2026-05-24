// Wallet session + optimistic display cache, shared across page loads.
//
// Each page (Home, Evidence, Peer Review) is a separate HTML entry point, so
// React state is lost on every navigation. Two distinct concerns are cached:
//
// 1. The CONNECTED ADDRESS is the live session and lives in sessionStorage. A
//    page session survives same-tab navigation and reloads but is cleared when
//    the tab/browser closes — so the user is automatically signed off on close.
//    We only auto-restore the wallet (from MetaMask's still-granted eth_accounts
//    permission) when this session address is present; an explicit disconnect
//    clears it, so navigating no longer silently reconnects.
//
// 2. The HANDLE / PEER STATE is a display optimisation keyed by address and
//    lives in localStorage. It only renders while there is an active session,
//    so persisting it across sessions is harmless — it just lets the connected
//    pill paint its final form immediately instead of flashing the address.

const ADDR_KEY    = 'walletAddr';
const handleKey   = (a) => `peerHandle:${String(a).toLowerCase()}`;
const peerKey     = (a) => `peerState:${String(a).toLowerCase()}`;

// Session-scoped connection (sessionStorage).
export const cachedAddr = () => { try { return sessionStorage.getItem(ADDR_KEY) || null; } catch { return null; } };
export const cacheAddr  = (a) => { try { if (a) sessionStorage.setItem(ADDR_KEY, a); else sessionStorage.removeItem(ADDR_KEY); } catch { /* ignore */ } };

// Display cache (localStorage), keyed by address.
export const cachedHandle = (a) => { try { return (a && localStorage.getItem(handleKey(a))) || ''; } catch { return ''; } };
export const cacheHandle  = (a, h) => { try { if (a) localStorage.setItem(handleKey(a), h || ''); } catch { /* ignore */ } };

export const cachedPeer = (a) => { try { return (a && JSON.parse(localStorage.getItem(peerKey(a)) || 'null')) || null; } catch { return null; } };
export const cachePeer  = (a, s) => { try { if (a) localStorage.setItem(peerKey(a), JSON.stringify(s)); } catch { /* ignore */ } };
