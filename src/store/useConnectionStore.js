/* ═══ Connection Store ═══ */
import { create } from 'zustand';
import { num } from '../lib/format.js';

const useConnectionStore = create((set) => ({
  status: 'disconnected',
  account: null,
  balance: 0,
  currency: 'USD',
  activeMarket: null,

  setStatus: (status) => set({ status }),
  setAccount: (account) => set({
    account,
    balance: num(account?.balance),
    currency: account?.currency || 'USD',
  }),
  setBalance: (balance) => set({ balance: num(balance) }),
  setActiveMarket: (market) => set({ activeMarket: market }),
}));

export default useConnectionStore;
