import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import RealMarketsTab from './pages/RealMarketsTab';
import History from './pages/History';
import Copytrade from './pages/Copytrade';
import Settings from './pages/Settings';
import useAccountStore from './store/useAccountStore';
import useConfigStore from './store/useConfigStore';
import Preloader from './components/Preloader';
import FloatingDisclaimer from './components/FloatingDisclaimer';
import OnboardingGuide from './components/OnboardingGuide';
import { Toaster } from 'react-hot-toast';
import { installTabKeepalive, registerTabKeepaliveListener } from './lib/tabKeepalive';
import tradeEngine from './lib/enhancedTradeEngine';
import { engine as realMarketEngine } from './lib/realMarketEngine';
import useTradeStore from './store/useTradeStore';
import { useRealMarketStore } from './stores/useRealMarketStore';
import { APP_ID, getRedirectUri } from './config';

// Helper to fetch account list using the new Options REST API
const getAccountList = async (token) => {
  const response = await fetch('https://api.derivws.com/trading/v1/options/accounts', {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Deriv-App-ID': APP_ID
    }
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData?.errors?.[0]?.message || errorData?.message || `HTTP ${response.status}`);
  }

  const result = await response.json();
  // Official API returns { data: [...] }
  return result.data || [];
};

export default function App() {
  const [isAuthorizing, setIsAuthorizing] = useState(false);
  const [authError, setAuthError] = useState(null);
  const [appReady, setAppReady] = useState(false);
  const theme = useConfigStore(s => s.theme);

  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [theme]);

  useEffect(() => {
    installTabKeepalive();
    const offBot = registerTabKeepaliveListener(() => {
      if (useTradeStore.getState().botRunning) {
        tradeEngine.wakeFromBackgroundTab();
      }
    });
    const offReal = registerTabKeepaliveListener(() => {
      if (useRealMarketStore.getState().autoTrade) {
        realMarketEngine.wakeFromBackgroundTab();
      }
    });
    return () => {
      offBot();
      offReal();
    };
  }, []);

  useEffect(() => {
    tradeEngine.onLiveAnalysisUpdate = (payload) => {
      useTradeStore.getState().setLiveAnalysisBoard(payload);
    };
    const syncPreview = () => {
      const strategy = useConfigStore.getState().strategy;
      if (useTradeStore.getState().botRunning) return;
      if (strategy === 'BOTH' || strategy === 'BOTH5') {
        tradeEngine.startSyntheticPreview(strategy);
      } else {
        tradeEngine.stopSyntheticPreview();
      }
    };
    syncPreview();
    const unsub = useConfigStore.subscribe(syncPreview);
    return () => {
      unsub();
      tradeEngine.stopSyntheticPreview();
      if (tradeEngine.onLiveAnalysisUpdate) tradeEngine.onLiveAnalysisUpdate = null;
    };
  }, []);

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    const state = urlParams.get('state');
    const error = urlParams.get('error');
    const errorDescription = urlParams.get('error_description');

    const clearParams = () => {
      sessionStorage.removeItem('oauth_code_verifier');
      sessionStorage.removeItem('oauth_state');
      const cleanUrl = window.location.origin + window.location.pathname;
      window.history.replaceState({}, document.title, cleanUrl);
    };

    if (error) {
      setAuthError(errorDescription || error || 'Authorization was cancelled or failed.');
      clearParams();
      return;
    }

    if (code && state) {
      const verifier = sessionStorage.getItem('oauth_code_verifier');
      const savedState = sessionStorage.getItem('oauth_state');

      if (state !== savedState) {
        setAuthError('Security verification failed: State parameters do not match.');
        clearParams();
        return;
      }

      if (!verifier) {
        setAuthError('Authentication session expired or code verifier not found.');
        clearParams();
        return;
      }

      setIsAuthorizing(true);

      const bodyParams = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: APP_ID,
        code,
        code_verifier: verifier,
        redirect_uri: getRedirectUri()
      });

      fetch('https://auth.deriv.com/oauth2/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: bodyParams.toString()
      })
        .then(res => {
          if (!res.ok) {
            return res.json().then(errData => {
              throw new Error(errData.error_description || errData.error || 'Token exchange failed');
            }).catch(() => {
              throw new Error(`Token exchange failed with status ${res.status}`);
            });
          }
          return res.json();
        })
        .then(data => {
          if (!data.access_token) {
            throw new Error('Authentication response did not return a valid access token.');
          }
          // Pass access_token along with the promise chain
          return getAccountList(data.access_token)
            .catch(err => {
              throw new Error(`Account List API Error: ${err.message}`);
            })
            .then(accountList => ({ access_token: data.access_token, accountList }));
        })
        .then(({ access_token, accountList }) => {
          if (accountList.length === 0) {
            throw new Error('No trading accounts associated with this session.');
          }
          const mappedAccounts = accountList.map(acc => ({
            id: acc.account_id,
            token: access_token, // Store the main OAuth token on each account
            loginid: acc.account_id,
            currency: acc.currency || 'USD',
            name: acc.account_type === 'demo' ? 'Demo Account' : 'Real Account',
            is_virtual: acc.account_type === 'demo',
            balance: typeof acc.balance === 'number' ? acc.balance : (parseFloat(acc.balance) || 0)
          }));
          useAccountStore.getState().addOAuthAccounts(mappedAccounts);
          setIsAuthorizing(false);
          clearParams();
        })
        .catch(err => {
          // Add prefix if it's a raw network failure (like CORS) from the token exchange
          const errMsg = err.message.includes('Failed to fetch') 
            ? `Token Exchange Network Error: ${err.message}` 
            : err.message;
          setAuthError(errMsg);
          setIsAuthorizing(false);
          clearParams();
        });
    }
  }, []);

  return (
    <>
      <Preloader onAccept={() => setAppReady(true)} />
      
      {appReady && (
        <BrowserRouter>
          <FloatingDisclaimer />
          <OnboardingGuide />
          <Toaster position="top-center" containerStyle={{ zIndex: 999999 }} toastOptions={{
            style: {
              background: '#1a1b20', // Solid background instead of transparent
              color: '#ffffff',
              border: 'none', // No borders
              boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
              maxWidth: '90vw',
              zIndex: 999999
            }
          }} />
      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      `}</style>

      {/* Premium Glassmorphic Loading Overlay */}
      {isAuthorizing && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(10, 15, 26, 0.85)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          zIndex: 9999,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          color: '#fff',
          animation: 'fadeIn 0.3s ease-out'
        }}>
          <div style={{
            width: 72,
            height: 72,
            borderRadius: '50%',
            border: '4px solid rgba(0, 229, 255, 0.1)',
            borderTop: '4px solid var(--cyan)',
            animation: 'spin 1s linear infinite',
            boxShadow: '0 0 20px rgba(0, 229, 255, 0.2)',
            marginBottom: 24
          }} />
          
          <h2 className="font-display animate-pulse" style={{ fontSize: 20, fontWeight: 700, margin: '0 0 8px 0', letterSpacing: '0.5px' }}>
            Authorizing Account
          </h2>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>
            Securing handshake and fetching your Deriv portfolios...
          </p>
        </div>
      )}

      {/* Premium Glassmorphic Error Modal */}
      {authError && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(10, 15, 26, 0.85)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          zIndex: 9999,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 16,
          animation: 'fadeIn 0.3s ease-out'
        }}>
          <div style={{
            maxWidth: 420, width: '100%',
            background: 'rgba(255, 255, 255, 0.03)',
            border: '1px solid rgba(255, 75, 75, 0.2)',
            borderRadius: 12,
            padding: '24px 32px',
            boxShadow: '0 20px 40px rgba(0, 0, 0, 0.4)',
            textAlign: 'center'
          }}>
            <div style={{
              width: 48, height: 48, borderRadius: '50%',
              background: 'rgba(255, 75, 75, 0.1)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              margin: '0 auto 16px auto'
            }}>
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--crimson)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
                <line x1="9" y1="9" x2="15" y2="15" />
              </svg>
            </div>

            <h3 className="font-display" style={{ fontSize: 18, fontWeight: 700, color: '#fff', margin: '0 0 8px 0' }}>
              Authentication Error
            </h3>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, margin: '0 0 24px 0' }}>
              {authError}
            </p>

            <button
              onClick={() => setAuthError(null)}
              style={{
                width: '100%',
                background: 'linear-gradient(135deg, var(--crimson) 0%, #ff5252 100%)',
                color: '#fff',
                border: 'none',
                borderRadius: 6,
                padding: '12px 20px',
                fontWeight: 700,
                fontSize: 13,
                cursor: 'pointer',
                boxShadow: '0 4px 15px rgba(255, 75, 75, 0.15)',
                transition: 'transform 0.2s, box-shadow 0.2s'
              }}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/real-markets" element={<RealMarketsTab />} />
            <Route path="/history" element={<History />} />
            <Route path="/copytrade" element={<Copytrade />} />
            <Route path="/settings" element={<Settings />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
      )}
    </>
  );
}
