import { useState, useRef, useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import { ChevronDown, Printer, LayoutDashboard, Radar, History, Settings, Plus, LogIn, Moon, Sun, Copy, RefreshCw } from 'lucide-react';
import useAccountStore from '../store/useAccountStore';
import useConnectionStore from '../store/useConnectionStore';
import useTradeStore from '../store/useTradeStore';
import useConfigStore from '../store/useConfigStore';
import derivWS from '../lib/derivWS';
import scanner from '../lib/marketScanner';
import { seedMarketHistory, registerMarketTickHandler } from '../lib/marketWarmup';
import { generatePKCE } from '../lib/pkce';
import { fmtMoney, num } from '../lib/format';
import { APP_ID, getRedirectUri } from '../config';

const NAV = [
  { to: '/', icon: LayoutDashboard, label: 'Synthetic Markets' },
  { to: '/real-markets', icon: Radar, label: 'Real Markets' },
  { to: '/history', icon: History, label: 'History' },
  { to: '/copytrade', icon: Copy, label: 'Copytrade' },
  { to: '/settings', icon: Settings, label: 'Settings' },
];

export default function Header({ bannerOffset = 0 }) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('demo'); // 'real' or 'demo'
  const [topupLoading, setTopupLoading] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  
  const dropdownRef = useRef(null);

  const accounts = useAccountStore(s => s.accounts);
  const activeAccountId = useAccountStore(s => s.activeAccountId);
  const setActiveAccountId = useAccountStore(s => s.setActiveAccountId);
  const updateAccountInfo = useAccountStore(s => s.updateAccountInfo);
  const logout = useAccountStore(s => s.logout);
  
  const status = useConnectionStore(s => s.status);
  const setStatus = useConnectionStore(s => s.setStatus);
  const setAccount = useConnectionStore(s => s.setAccount);
  const accountInfo = useConnectionStore(s => s.account);
  
  const botRunning = useTradeStore(s => s.botRunning);
  
  const theme = useConfigStore(s => s.theme);
  const updateConfig = useConfigStore(s => s.updateConfig);
  
  const isLoggedIn = accounts && accounts.length > 0;

  const handleLogin = async () => {
    try {
      const { codeVerifier, codeChallenge, state } = await generatePKCE();
      sessionStorage.setItem('oauth_code_verifier', codeVerifier);
      sessionStorage.setItem('oauth_state', state);

      const params = new URLSearchParams({
        response_type: 'code',
        client_id: APP_ID,
        redirect_uri: getRedirectUri(),
        scope: 'trade',
        state: state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256'
      });

      window.location.href = `https://auth.deriv.com/oauth2/auth?${params.toString()}`;
    } catch (err) {
      console.error('Failed to initiate login:', err);
    }
  };

  // Close dropdown on click outside
  useEffect(() => {
    function handleClickOutside(event) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [dropdownRef]);

  // Auto-connect to active account on first load (skip if preloader already warmed session)
  useEffect(() => {
    if (status === 'authorized' && derivWS.isReady) {
      registerMarketTickHandler();
      if (!scanner.isWarmed(10)) {
        seedMarketHistory().catch(err => console.error('Market warmup error:', err));
      }
      const activeAcc = accounts.find(a => a.id === activeAccountId) || accounts[0];
      if (activeAcc) {
        derivWS.onAccountUpdate = (info) => {
          setAccount(info);
          updateAccountInfo(activeAcc.id, {
            balance: info.balance, currency: info.currency,
            loginid: info.loginid,
          });
        };
      }
      return;
    }
    if (status === 'disconnected' && !botRunning && accounts.length > 0) {
      const activeAcc = accounts.find(a => a.id === activeAccountId);
      if (activeAcc) {
        handleConnect(activeAcc);
      } else {
        const demoAcc = accounts.find(a => a.is_virtual || a.loginid?.startsWith('VR'));
        if (demoAcc) {
          handleConnect(demoAcc);
        }
      }
    }
  }, [accounts, activeAccountId, status, botRunning]); // Run on mount or when accounts load

  // Derive Real/Demo accounts heuristics
  const demoAccounts = accounts.filter(a => a.is_virtual || a.loginid?.startsWith('VR'));
  const realAccounts = accounts.filter(a => !a.is_virtual && !a.loginid?.startsWith('VR'));

  const currentAccounts = activeTab === 'demo' ? demoAccounts : realAccounts;
  const activeAccount = accounts.find(a => a.id === activeAccountId);
  const isDemoActive = activeAccount?.is_virtual || activeAccount?.loginid?.startsWith('VR');

  const totalAssets = currentAccounts.reduce((acc, a) => acc + num(a.balance), 0);

  const fetchBalances = async () => {
    if (!accounts.length || !accounts[0].token) return;
    try {
      // Use the new REST API to fetch all account balances
      derivWS.token = accounts[0].token;
      const apiAccounts = await derivWS.fetchAccounts();
      apiAccounts.forEach(apiAcc => {
        const localAcc = useAccountStore.getState().accounts.find(a => a.loginid === apiAcc.account_id);
        if (localAcc) {
          const bal = typeof apiAcc.balance === 'number' ? apiAcc.balance : parseFloat(apiAcc.balance) || 0;
          updateAccountInfo(localAcc.id, { balance: bal, currency: apiAcc.currency || 'USD' });
        }
      });
    } catch (err) {
      console.error('Failed to fetch balances via REST:', err);
    }
  };

  useEffect(() => {
    if (dropdownOpen) {
      fetchBalances();
    }
  }, [dropdownOpen]);

  // Also fetch balances on initial mount when accounts exist
  useEffect(() => {
    if (accounts.length > 0 && accounts[0].token) {
      fetchBalances();
    }
  }, [accounts.length]);

  const handleConnect = (account) => {
    if (botRunning || status === 'connecting') return;
    if (status === 'authorized' && activeAccountId === account.id && derivWS.isReady) {
      setActiveAccountId(account.id);
      setDropdownOpen(false);
      return;
    }
    setDropdownOpen(false);
    derivWS.disconnect();
    setActiveAccountId(account.id);
    
    derivWS.onStatusChange = (newStatus) => {
      setStatus(newStatus);
      if (newStatus === 'authorized') {
        registerMarketTickHandler();
        seedMarketHistory().catch(err => console.error('Market warmup error:', err));
      }
    };
    derivWS.onAccountUpdate = (info) => {
      setAccount(info);
      updateAccountInfo(account.id, {
        balance: info.balance, currency: info.currency,
        loginid: info.loginid
      });
    };
    derivWS.connect(account.token, account.loginid);
  };

  const handleTopup = async () => {
    if (topupLoading || !isDemoActive || !activeAccount) return;
    setTopupLoading(true);
    try {
      // Use new REST API endpoint for demo balance reset
      await derivWS.resetDemoBalance(activeAccount.loginid);
      // Refresh balances from REST
      await fetchBalances();
      // Also sync the active account balance in connection store
      await derivWS._syncAccountBalance();
    } catch (e) {
      console.error('Reset demo balance error:', e);
    }
    setTopupLoading(false);
  };

  return (
    <header style={{
      position: 'fixed', top: bannerOffset, left: 0, right: 0, zIndex: 50,
      display: 'flex', flexDirection: 'column',
      background: 'var(--bg-secondary)',
      borderBottom: '1px solid var(--border)',
    }}>
      
      {/* Row 1: Logo + Account Info */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        width: '100%', maxWidth: 1600, margin: '0 auto', padding: '0 16px', height: 70, 
      }}>
        
        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 44, height: 44 }}>
            <img src="./logo.png" alt="Deriv printer Logo" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
          </div>
          <span className="font-display" style={{ fontSize: 20, fontWeight: 700 }}>Deriv printer</span>
        </div>

        {/* Right Side: Theme + Account */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginRight: 16 }}>
          
          {/* Connection Status Dot */}
          <div style={{
            width: 8, height: 8, borderRadius: '50%',
            background: status === 'authorized' ? 'var(--success)' : 'var(--text-muted)'
          }} />

          {/* Theme Toggle */}
          <button
            onClick={() => updateConfig({ theme: theme === 'dark' ? 'light' : 'dark' })}
            title="Toggle Theme"
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--text-primary)', padding: '4px'
            }}
          >
            {theme === 'dark' ? <Moon size={16} /> : <Sun size={16} />}
          </button>

          {isLoggedIn && isDemoActive && (
            <button
              onClick={handleTopup}
              disabled={topupLoading}
              title="Reset Demo Balance"
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '6px 12px', border: '1px solid var(--border)', borderRadius: 6,
                background: 'var(--surface)', color: 'var(--text-primary)', fontSize: 12, fontWeight: 600,
                cursor: topupLoading ? 'wait' : 'pointer'
              }}
            >
              <RefreshCw size={14} className={topupLoading ? 'animate-spin' : ''} />
              <span className="hidden sm:inline">{topupLoading ? 'Resetting...' : 'Reset'}</span>
            </button>
          )}

          {/* Account Dropdown Toggle */}
          <div ref={dropdownRef} style={{ position: 'relative' }}>
            {isLoggedIn ? (
              <button 
                onClick={() => setDropdownOpen(!dropdownOpen)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  padding: '8px 12px', borderRadius: 8
                }}
              >
                <div style={{
                  width: 28, height: 28, borderRadius: '50%',
                  background: 'var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center'
                }}>
                  <span style={{ fontSize: 12, fontWeight: 'bold', color: 'var(--text-primary)' }}>
                    {isDemoActive ? 'D' : 'R'}
                  </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                      {isDemoActive ? 'Demo' : 'Real'}
                    </span>
                    <ChevronDown size={14} color="var(--text-muted)" />
                  </div>
                  <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>
                    {fmtMoney(accountInfo?.balance)} {accountInfo?.currency || 'USD'}
                  </span>
                </div>
              </button>
            ) : (
              <button
                onClick={handleLogin}
                style={{
                  background: 'linear-gradient(135deg, var(--cyan) 0%, #ff6b74 100%)',
                  color: '#fff', border: 'none', borderRadius: 6,
                  padding: '8px 16px', fontWeight: 700, fontSize: 12,
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6
                }}
              >
                <LogIn size={14} />
                Connect Deriv
              </button>
            )}

            {/* Desktop Dropdown Menu */}
            {dropdownOpen && (
              <div style={{
                position: 'absolute', top: '100%', right: 0, marginTop: 8,
                width: 320, background: 'var(--surface)', borderRadius: 8,
                boxShadow: '0 4px 20px rgba(0,0,0,0.5)', overflow: 'hidden',
                color: 'var(--text-primary)', border: '1px solid var(--border)'
              }}>
                {/* Tabs */}
                <div style={{ display: 'flex', borderBottom: '1px solid var(--border)' }}>
                  <button 
                    onClick={() => setActiveTab('real')}
                    style={{
                      flex: 1, padding: '12px 0', border: 'none', background: 'transparent',
                      fontWeight: 600, fontSize: 14, cursor: 'pointer',
                      borderBottom: activeTab === 'real' ? '2px solid var(--crimson)' : '2px solid transparent',
                      color: activeTab === 'real' ? 'var(--text-primary)' : 'var(--text-muted)'
                    }}
                  >Real</button>
                  <button 
                    onClick={() => setActiveTab('demo')}
                    style={{
                      flex: 1, padding: '12px 0', border: 'none', background: 'transparent',
                      fontWeight: 600, fontSize: 14, cursor: 'pointer',
                      borderBottom: activeTab === 'demo' ? '2px solid var(--crimson)' : '2px solid transparent',
                      color: activeTab === 'demo' ? 'var(--text-primary)' : 'var(--text-muted)'
                    }}
                  >Demo</button>
                </div>

                {/* Account List */}
                <div style={{ padding: '16px', maxHeight: 400, overflowY: 'auto' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <div style={{ fontSize: 14, fontWeight: 700 }}>Deriv account</div>
                  </div>
                  
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {currentAccounts.map(acc => {
                      const isCurrent = activeAccountId === acc.id;
                      return (
                        <div 
                          key={acc.id}
                          onClick={() => { if(!isCurrent) { handleConnect(acc); setDropdownOpen(false); } }}
                          style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                            padding: '14px', borderRadius: 8,
                            background: isCurrent ? 'var(--surface-hover)' : 'transparent',
                            border: isCurrent ? '1px solid var(--border)' : '1px solid transparent',
                            cursor: isCurrent ? 'default' : 'pointer',
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                            <div style={{
                              width: 28, height: 28, borderRadius: '50%', background: '#9ca3af',
                              display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 12, fontWeight: 700
                            }}>
                              {activeTab === 'demo' ? 'D' : 'R'}
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column' }}>
                              <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>
                                {activeTab === 'demo' ? 'Demo' : 'Real'}
                              </span>
                              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{acc.loginid || 'No ID'}</span>
                            </div>
                          </div>
                          
                          {isCurrent && activeTab === 'demo' && (
                            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--cyan)' }}>
                              {Number.isFinite(num(acc.balance)) ? `${fmtMoney(acc.balance)} ${acc.currency}` : '--'}
                            </span>
                          )}
                          {!isCurrent && (
                            <span style={{ fontSize: 14, fontWeight: 600 }}>
                              {Number.isFinite(num(acc.balance)) ? `${fmtMoney(acc.balance)} ${acc.currency}` : '--'}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* Total Assets */}
                  <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 14, fontWeight: 700 }}>Total assets</span>
                      <span style={{ fontSize: 14 }}>{fmtMoney(totalAssets)} USD</span>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                      Total assets in your Deriv accounts.
                    </div>
                  </div>
                </div>

                <button 
                  onClick={() => { setDropdownOpen(false); logout(); }}
                  style={{
                    width: '100%', padding: '12px 0', border: 'none', background: 'rgba(255, 68, 79, 0.05)',
                    fontWeight: 600, fontSize: 13, cursor: 'pointer',
                    color: 'var(--crimson)', borderTop: '1px solid var(--border)',
                    transition: 'all 0.2s', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6
                  }}
                >
                  Log Out / Disconnect
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Row 2: Navigation */}
      <nav style={{
        display: 'flex', alignItems: 'center', gap: 4,
        height: 50, width: '100%', maxWidth: 1600, margin: '0 auto', padding: '0 16px', overflowX: 'auto',
        borderTop: '1px solid var(--border)',
      }}>
        {NAV.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            style={({ isActive }) => ({
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '0 10px', height: '100%',
              color: isActive ? 'var(--cyan)' : 'var(--text-muted)',
              fontWeight: isActive ? 600 : 500,
              borderBottom: isActive ? '2px solid var(--cyan)' : '2px solid transparent',
              textDecoration: 'none',
              transition: 'all 0.2s',
              whiteSpace: 'nowrap',
              fontSize: 13,
            })}
            title={label}
          >
            <Icon size={18} />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
      
    </header>
  );
}
