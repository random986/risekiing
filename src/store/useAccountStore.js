import { create } from 'zustand';
import derivWS from '../lib/derivWS';
import useConnectionStore from './useConnectionStore';

const STORAGE_KEY = 'derivprinter_accounts';
const ACTIVE_STORAGE_KEY = 'derivprinter_active_account_id';

const DEFAULT_ACCOUNTS = [];

function loadAccounts() {
  let accounts = [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      accounts = JSON.parse(raw);
    }
  } catch {}
  
  // Filter out any legacy accounts that don't have a valid loginid or have deprecated tokens
  accounts = accounts.filter(acc => 
    acc && 
    acc.loginid && 
    acc.token && 
    acc.token !== 'zC1SkSXgajB5ymD' && 
    acc.token !== 'pWGBoEP019BLM2F'
  );
  
  if (accounts.length === 0) {
    accounts = [...DEFAULT_ACCOUNTS];
  }
  
  return accounts;
}

let initialActiveId = null;
try {
  initialActiveId = localStorage.getItem(ACTIVE_STORAGE_KEY);
} catch {}

const useAccountStore = create((set, get) => ({
  accounts: loadAccounts(),
  activeAccountId: initialActiveId,

  addAccount: (account) => {
    set((state) => {
      const newAccounts = [...state.accounts, { ...account, id: Date.now().toString() }];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newAccounts));
      return { accounts: newAccounts };
    });
  },

  removeAccount: (id) => {
    set((state) => {
      const newAccounts = state.accounts.filter(a => a.id !== id);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newAccounts));
      const nextActiveId = state.activeAccountId === id ? null : state.activeAccountId;
      if (nextActiveId) {
        localStorage.setItem(ACTIVE_STORAGE_KEY, nextActiveId);
      } else {
        localStorage.removeItem(ACTIVE_STORAGE_KEY);
      }
      return { 
        accounts: newAccounts,
        activeAccountId: nextActiveId
      };
    });
  },

  setActiveAccountId: (id) => {
    try {
      if (id) {
        localStorage.setItem(ACTIVE_STORAGE_KEY, id);
      } else {
        localStorage.removeItem(ACTIVE_STORAGE_KEY);
      }
    } catch {}
    set({ activeAccountId: id });
  },

  updateAccountInfo: (id, info) => {
    set((state) => {
      const newAccounts = state.accounts.map(a => 
        a.id === id ? { ...a, ...info } : a
      );
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newAccounts));
      return { accounts: newAccounts };
    });
  },

  addOAuthAccounts: (oauthAccounts) => {
    set((state) => {
      const existing = [...state.accounts];
      oauthAccounts.forEach(newAcc => {
        const idx = existing.findIndex(a => a.loginid === newAcc.loginid);
        if (idx !== -1) {
          existing[idx] = { ...existing[idx], ...newAcc };
        } else {
          existing.push(newAcc);
        }
      });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(existing));
      
      let newActiveId = state.activeAccountId;
      if (oauthAccounts.length > 0) {
        newActiveId = oauthAccounts[0].id;
        localStorage.setItem(ACTIVE_STORAGE_KEY, newActiveId);
      }
      return { accounts: existing, activeAccountId: newActiveId };
    });
  },

  logout: () => {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(ACTIVE_STORAGE_KEY);
    derivWS.disconnect();
    
    // Reset connection store state
    try {
      const connState = useConnectionStore.getState();
      if (connState) {
        connState.setAccount(null);
        connState.setStatus('disconnected');
      }
    } catch (e) {
      console.error('Failed to reset connection state:', e);
    }
    
    set({ accounts: [], activeAccountId: null });
  }
}));

export default useAccountStore;
