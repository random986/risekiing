/* ═══ Settings Page — Premium Grid Layout ═══ */
import { useState } from 'react';
import { Settings2, Shield, Plus, Key, Copy, Check, Trash2, SlidersHorizontal, Activity, Link2 } from 'lucide-react';
import useConfigStore from '../store/useConfigStore';
import useTradeStore from '../store/useTradeStore';
import useAccountStore from '../store/useAccountStore';
import useConnectionStore from '../store/useConnectionStore';
import { useRealMarketStore } from '../stores/useRealMarketStore';
import { generatePKCE } from '../lib/pkce';
import { APP_ID, getRedirectUri } from '../config';


function SliderInput({ label, value, onChange, min, max, step, unit = '' }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{label}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="number" value={value}
            onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
            style={{
              width: 70, background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border)',
              borderRadius: 6, color: 'var(--text-primary)', fontSize: 13, padding: '4px 8px', textAlign: 'right',
            }}
          />
          {unit && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{unit}</span>}
        </div>
      </div>
      <div className="hidden md:block">
        <input
          type="range" min={min} max={max} step={step} value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          style={{ width: '100%', accentColor: 'var(--cyan)' }}
        />
      </div>
    </div>
  );
}

export default function Settings() {
  const config = useConfigStore();
  const logout = useAccountStore(s => s.logout);
  const status = useConnectionStore(s => s.status);
  const accountInfo = useConnectionStore(s => s.account);

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

  const [settingsTab, setSettingsTab] = useState('synthetic');
  const realStore = useRealMarketStore();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 1000, margin: '0 auto' }}>
      
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div>
          <h1 className="font-display" style={{ fontSize: 26, fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: 12 }}>
            <Settings2 size={28} color="var(--cyan)" />
            Terminal Settings
          </h1>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>
            Manage your Deriv API keys, algorithm strategy, and strict risk guardrails.
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)' }}>
        <button 
          onClick={() => setSettingsTab('synthetic')}
          style={{
            padding: '12px 24px', border: 'none', background: 'transparent',
            fontWeight: 600, fontSize: 14, cursor: 'pointer',
            borderBottom: settingsTab === 'synthetic' ? '2px solid var(--cyan)' : '2px solid transparent',
            color: settingsTab === 'synthetic' ? 'var(--text-primary)' : 'var(--text-muted)'
          }}
        >
          Synthetic Markets
        </button>
        <button 
          onClick={() => setSettingsTab('real')}
          style={{
            padding: '12px 24px', border: 'none', background: 'transparent',
            fontWeight: 600, fontSize: 14, cursor: 'pointer',
            borderBottom: settingsTab === 'real' ? '2px solid var(--cyan)' : '2px solid transparent',
            color: settingsTab === 'real' ? 'var(--text-primary)' : 'var(--text-muted)'
          }}
        >
          Real Markets
        </button>
        
      </div>

      {settingsTab === 'synthetic' && (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* Left Column — Staking */}
        <div className="flex flex-col gap-6">

          {/* Staking & Martingale */}
          <div className="glass" style={{ padding: '24px' }}>
            <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 8 }}>
              <SlidersHorizontal size={18} color="var(--cyan)" />
              Staking Rules
            </h2>
            <SliderInput
              label="Base Stake" value={config.baseStake} unit="USD"
              onChange={(v) => config.updateConfig({ baseStake: v })}
              min={0.35} max={50} step={0.01}
            />

            {/* Martingale toggle */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div>
                  <span style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 600 }}>Martingale</span>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                    {config.recoveryEnabled
                      ? `Stake = base × ${config.martMultiplier ?? 2}^n after each loss; resets on win`
                      : 'Disabled — flat stake every trade'}
                  </div>
                </div>
                <button
                  onClick={() => config.updateConfig({ recoveryEnabled: !config.recoveryEnabled })}
                  style={{
                    width: 48, height: 26, borderRadius: 13, border: 'none', cursor: 'pointer',
                    background: config.recoveryEnabled ? 'var(--cyan)' : 'rgba(255,255,255,0.1)',
                    position: 'relative', transition: 'background 0.2s',
                  }}
                >
                  <div style={{
                    width: 20, height: 20, borderRadius: '50%', background: '#fff',
                    position: 'absolute', top: 3,
                    left: config.recoveryEnabled ? 25 : 3,
                    transition: 'left 0.2s',
                  }} />
                </button>
              </div>
            </div>

            {config.recoveryEnabled && (
              <>
                <SliderInput
                  label="Martingale Multiplier" value={config.martMultiplier ?? 2} unit="x"
                  onChange={(v) => config.updateConfig({ martMultiplier: v })}
                  min={1.1} max={4} step={0.1}
                />
                <SliderInput
                  label="Max Martingale Steps (0 = unlimited)" value={config.maxSteps ?? 0} unit="Steps"
                  onChange={(v) => config.updateConfig({ maxSteps: v })}
                  min={0} max={15} step={1}
                />
                <SliderInput
                  label="Hybrid Max Recovery Steps (0 = unlimited)" value={config.hybridMaxSteps ?? 0} unit="Steps"
                  onChange={(v) => config.updateConfig({ hybridMaxSteps: v })}
                  min={0} max={15} step={1}
                />
                <SliderInput
                  label="Hybrid Take Profit (0 = off)" value={config.hybridTakeProfit ?? 0} unit="USD"
                  onChange={(v) => config.updateConfig({ hybridTakeProfit: v })}
                  min={0} max={100} step={1}
                />
                <SliderInput
                  label="Hybrid Stop Loss (Currency) (0 = off)" value={config.hybridStopLossCurrency ?? 0} unit="USD"
                  onChange={(v) => config.updateConfig({ hybridStopLossCurrency: v })}
                  min={0} max={100} step={1}
                />
                <SliderInput
                  label="Hybrid Stop Loss (Steps) (0 = off)" value={config.hybridStopLossSteps ?? 0} unit="Steps"
                  onChange={(v) => config.updateConfig({ hybridStopLossSteps: v })}
                  min={0} max={15} step={1}
                />
                <SliderInput
                  label="Max Stake Cap (0 = unlimited)" value={config.maxStakeCap ?? 0} unit="USD"
                  onChange={(v) => config.updateConfig({ maxStakeCap: v })}
                  min={0} max={100} step={1}
                />
              </>
            )}
          </div>

          {/* Rise/Fall Duration */}
          <div className="glass" style={{ padding: '24px' }}>
            <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Settings2 size={18} color="var(--cyan)" />
              Rise/Fall Strategy Settings
            </h2>
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Duration Unit</span>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {['t', 's', 'm'].map(unit => {
                  const label = unit === 't' ? 'Ticks' : unit === 's' ? 'Seconds' : 'Minutes';
                  return (
                    <button
                      key={unit}
                      onClick={() => config.updateConfig({ riseFallDurationUnit: unit })}
                      style={{
                        padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                        background: config.riseFallDurationUnit === unit ? 'var(--cyan)' : 'rgba(255,255,255,0.05)',
                        color: config.riseFallDurationUnit === unit ? '#000' : 'var(--text-muted)',
                        border: config.riseFallDurationUnit === unit ? 'none' : '1px solid var(--border)',
                        transition: 'all 0.2s'
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
            <SliderInput
              label="Duration Amount" 
              value={config.riseFallDuration || 30} 
              unit={config.riseFallDurationUnit === 't' ? 'Ticks' : config.riseFallDurationUnit === 'm' ? 'Mins' : 'Secs'}
              onChange={(v) => config.updateConfig({ riseFallDuration: v })}
              min={1} max={100} step={1}
            />
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: -12 }}>
              Used exclusively when trading the RISE or FALL strategy. Note: Recovery for Rise/Fall is hardcoded to exact XML formula: current_stake + (loss * 1.071).
            </div>
          </div>

          {/* Appearance */}
          <div className="glass" style={{ padding: '24px' }}>
            <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Settings2 size={18} color="var(--cyan)" />
              Appearance
            </h2>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Dark Mode</div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Toggle dark/light theme</div>
              </div>
              <button
                onClick={() => config.updateConfig({ theme: config.theme === 'dark' ? 'light' : 'dark' })}
                style={{
                  width: 44, height: 24, borderRadius: 12,
                  background: config.theme === 'dark' ? 'var(--cyan)' : 'var(--border)',
                  border: 'none', position: 'relative', cursor: 'pointer',
                  transition: 'background 0.2s'
                }}
              >
                <div style={{
                  width: 20, height: 20, borderRadius: '50%', background: '#fff',
                  position: 'absolute', top: 2,
                  left: config.theme === 'dark' ? 22 : 2,
                  transition: 'left 0.2s',
                }} />
              </button>
            </div>
          </div>
        </div>

        {/* Right Column — Risk Controls + Account */}
        <div className="flex flex-col gap-6">

          {/* Risk Controls */}
          <div className="glass" style={{ padding: '24px' }}>
            <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Shield size={18} color="var(--amber)" />
              Session Risk Controls
            </h2>

            {/* Take Profit Type */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Take Profit Type</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() => config.updateConfig({ takeProfitType: 'currency', takeProfit: 0 })}
                  style={{
                    padding: '4px 12px', fontSize: 12, borderRadius: 4, cursor: 'pointer',
                    background: (!config.takeProfitType || config.takeProfitType === 'currency') ? 'var(--cyan)' : 'rgba(255,255,255,0.1)',
                    color: (!config.takeProfitType || config.takeProfitType === 'currency') ? '#000' : 'var(--text-primary)',
                    border: 'none', fontWeight: (!config.takeProfitType || config.takeProfitType === 'currency') ? 700 : 400
                  }}
                >
                  Currency
                </button>
                <button
                  onClick={() => config.updateConfig({ takeProfitType: 'wins', takeProfit: 0 })}
                  style={{
                    padding: '4px 12px', fontSize: 12, borderRadius: 4, cursor: 'pointer',
                    background: config.takeProfitType === 'wins' ? 'var(--cyan)' : 'rgba(255,255,255,0.1)',
                    color: config.takeProfitType === 'wins' ? '#000' : 'var(--text-primary)',
                    border: 'none', fontWeight: config.takeProfitType === 'wins' ? 700 : 400
                  }}
                >
                  Wins
                </button>
              </div>
            </div>

            {/* Take Profit */}
            <SliderInput
              label={`Take Profit (0 = off)`}
              value={config.takeProfit || 0}
              unit={config.takeProfitType === 'wins' ? 'Wins' : 'USD'}
              onChange={(v) => config.updateConfig({ takeProfit: v })}
              min={0}
              max={config.takeProfitType === 'wins' ? 100 : 500}
              step={1}
            />
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: -12, marginBottom: 16 }}>
              Auto-stop when session profit ≥ this {config.takeProfitType === 'wins' ? 'number of wins' : 'amount'}. 0 = run continuously.
            </div>

            {/* Stop Loss */}
            <SliderInput
              label="Stop Loss (0 = off)" value={config.stopLoss || 0} unit="USD"
              onChange={(v) => config.updateConfig({ stopLoss: v })}
              min={0} max={500} step={1}
            />
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: -12, marginBottom: 16 }}>
              Auto-stop when session loss ≥ this amount. 0 = run continuously.
            </div>

            {/* Time Stop */}
            <div style={{ marginBottom: 4 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Time Stop (0 = off)</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="number"
                    value={Math.round((config.timeStopMs || 0) / 60000)}
                    min={0}
                    onChange={(e) => {
                      const mins = Math.max(0, parseInt(e.target.value) || 0);
                      config.updateConfig({ timeStopMs: mins * 60000 });
                    }}
                    style={{
                      width: 70, background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border)',
                      borderRadius: 6, color: 'var(--text-primary)', fontSize: 13, padding: '4px 8px', textAlign: 'right',
                    }}
                  />
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>min</span>
                </div>
              </div>
              <div className="hidden md:block">
                <input
                  type="range" min={0} max={480} step={5}
                  value={Math.round((config.timeStopMs || 0) / 60000)}
                  onChange={(e) => config.updateConfig({ timeStopMs: parseInt(e.target.value) * 60000 })}
                  style={{ width: '100%', accentColor: 'var(--cyan)' }}
                />
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6 }}>
                {(config.timeStopMs || 0) > 0
                  ? `Bot auto-stops after ${Math.round(config.timeStopMs / 60000)} min (${(config.timeStopMs / 3600000).toFixed(1)} hr).`
                  : 'Bot runs until manually stopped, TP, or SL hit.'}
              </div>
            </div>
          </div>

          {/* Connected Account */}
          <div className="glass" style={{ padding: '24px' }}>
            <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Shield size={18} color="var(--cyan)" />
              Account Profile
            </h2>

            {status === 'authorized' && accountInfo ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{
                    width: 48, height: 48, borderRadius: '50%',
                    background: 'var(--cyan)', color: '#000',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 18, fontWeight: 700
                  }}>
                    {accountInfo.fullname ? accountInfo.fullname.charAt(0) : 'U'}
                  </div>
                  <div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>
                      {accountInfo.fullname || 'Deriv User'}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      ID: {accountInfo.loginid}
                    </div>
                  </div>
                </div>

                <div style={{ height: '1px', background: 'var(--border)', margin: '8px 0' }} />

                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                    <span style={{ color: 'var(--text-secondary)' }}>Currency</span>
                    <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{accountInfo.currency || 'USD'}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                    <span style={{ color: 'var(--text-secondary)' }}>Balance</span>
                    <span style={{ color: 'var(--cyan)', fontWeight: 700 }}>
                      {accountInfo.balance !== undefined ? parseFloat(accountInfo.balance).toFixed(2) : '0.00'} {accountInfo.currency || 'USD'}
                    </span>
                  </div>
                </div>

                <button
                  onClick={logout}
                  style={{
                    marginTop: 16,
                    width: '100%',
                    background: 'rgba(255, 75, 75, 0.1)',
                    border: '1px solid var(--crimson)',
                    color: 'var(--crimson)',
                    borderRadius: 6,
                    padding: '12px 20px',
                    fontWeight: 600,
                    fontSize: 13,
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                    textAlign: 'center'
                  }}
                >
                  Disconnect Account
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '10px 0', textAlign: 'center' }}>
                <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 20 }}>
                  No active session. Please log in to your Deriv account.
                </p>
                <button
                  onClick={handleLogin}
                  style={{
                    width: '100%',
                    background: 'var(--cyan)',
                    color: '#ffffff',
                    border: 'none',
                    borderRadius: 8,
                    padding: '12px 20px',
                    fontWeight: 600,
                    fontSize: 14,
                    cursor: 'pointer',
                    boxShadow: '0 4px 15px rgba(255, 68, 79, 0.25)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transition: 'all 0.2s ease',
                  }}
                >
                  Connect to Deriv
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      )}

      {settingsTab === 'real' && (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left Column — Staking & Strategy */}
        <div className="flex flex-col gap-6">

          {/* Staking Rules */}
          <div className="glass" style={{ padding: '24px' }}>
            <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 8 }}>
              <SlidersHorizontal size={18} color="var(--cyan)" />
              Real Market Staking Rules
            </h2>
            <SliderInput
              label="Base Stake" value={realStore.baseStake} unit="USD"
              onChange={(v) => realStore.setBaseStake(v)}
              min={0.35} max={50} step={0.01}
            />
            <SliderInput
              label="Max Stake Cap (0 = off)" value={realStore.maxStakeCap || 0} unit="USD"
              onChange={(v) => useRealMarketStore.setState({ maxStakeCap: v })}
              min={0} max={100} step={1}
            />
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: -12, marginBottom: 12 }}>
              Maximum stake the engine can ever place per contract.
            </div>
          </div>

          {/* Rise/Fall Strategy */}
          <div className="glass" style={{ padding: '24px' }}>
            <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Activity size={18} color="var(--success)" />
              Rise/Fall Configuration
            </h2>
            <SliderInput
              label="Min Efficiency Ratio (ER) for entry" value={realStore.minERForRiseFall ?? 0.60} unit=""
              onChange={(v) => useRealMarketStore.setState({ minERForRiseFall: v })}
              min={0.30} max={0.90} step={0.05}
            />
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: -12, marginBottom: 12 }}>
              Markets with ER below this threshold won't be routed to Rise/Fall.
            </div>
            <SliderInput
              label="Max SVC (Spread vs Candle) for entry" value={realStore.maxSVCForRiseFall ?? 0.15} unit=""
              onChange={(v) => useRealMarketStore.setState({ maxSVCForRiseFall: v })}
              min={0.05} max={0.30} step={0.01}
            />
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: -12, marginBottom: 12 }}>
              Higher spread-to-candle ratios indicate unfavourable execution conditions.
            </div>
            <SliderInput
              label="Alpha σ Threshold for trigger" value={realStore.alphaSigmaThreshold ?? 2.0} unit="σ"
              onChange={(v) => useRealMarketStore.setState({ alphaSigmaThreshold: v })}
              min={1.0} max={4.0} step={0.1}
            />
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: -12, marginBottom: 12 }}>
              How many standard deviations of velocity acceleration (α) above the mean to trigger entry.
            </div>
            <SliderInput
              label="Min MCS Score for Rise/Fall" value={realStore.minMCSForRiseFall ?? 0.40} unit=""
              onChange={(v) => useRealMarketStore.setState({ minMCSForRiseFall: v })}
              min={0.20} max={0.90} step={0.05}
            />
          </div>

          {/* Accumulator Strategy */}
          <div className="glass" style={{ padding: '24px' }}>
            <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Activity size={18} color="var(--cyan)" />
              Accumulator Configuration
            </h2>
            <SliderInput
              label="Max ER for Accumulator routing" value={realStore.maxERForAccumulator ?? 0.30} unit=""
              onChange={(v) => useRealMarketStore.setState({ maxERForAccumulator: v })}
              min={0.10} max={0.50} step={0.05}
            />
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: -12, marginBottom: 12 }}>
              Accumulators work best in low-trend (compressing) conditions.
            </div>
            <SliderInput
              label="TII Exhaustion Threshold" value={realStore.tiiThreshold ?? 0.75} unit=""
              onChange={(v) => useRealMarketStore.setState({ tiiThreshold: v })}
              min={0.40} max={1.20} step={0.05}
            />
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: -12, marginBottom: 12 }}>
              TII (Tick Intensity Index) below this value indicates volume exhaustion — ideal for accumulators.
            </div>
            <SliderInput
              label="BB Proximity Squeeze Threshold" value={(realStore.bbProxThreshold ?? 0.0005) * 10000} unit="pips (÷10000)"
              onChange={(v) => useRealMarketStore.setState({ bbProxThreshold: v / 10000 })}
              min={1} max={20} step={1}
            />
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: -12, marginBottom: 12 }}>
              Bollinger Band proximity below this value signals a squeeze. Displayed as pips × 10000 for readability.
            </div>
            <SliderInput
              label="Growth Rate (%)" value={(realStore.accumulatorGrowthRate ?? 0.01) * 100} unit="%"
              onChange={(v) => useRealMarketStore.setState({ accumulatorGrowthRate: v / 100 })}
              min={1} max={5} step={1}
            />
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: -12, marginBottom: 12 }}>
              Accumulator growth rate: 1% (safest), 2%, 3%, 4%, 5% (highest risk/reward).
            </div>
            <SliderInput
              label="Min MCS Score for Accumulator" value={realStore.minMCSForAccumulator ?? 0.40} unit=""
              onChange={(v) => useRealMarketStore.setState({ minMCSForAccumulator: v })}
              min={0.20} max={0.90} step={0.05}
            />
          </div>
        </div>

        {/* Right Column — Risk & Duration */}
        <div className="flex flex-col gap-6">

          {/* Risk Guardrails */}
          <div className="glass" style={{ padding: '24px' }}>
            <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Shield size={18} color="var(--amber)" />
              Risk Guardrails
            </h2>
            <SliderInput
              label="Session Drawdown Stop" value={(realStore.drawdownLimitPct ?? 5)} unit="%"
              onChange={(v) => useRealMarketStore.setState({ drawdownLimitPct: v })}
              min={1} max={25} step={1}
            />
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: -12, marginBottom: 12 }}>
              Kill switch auto-engages if session P&L drops below this % of starting balance.
            </div>
            <SliderInput
              label="Consecutive Loss Pause Limit" value={realStore.consecutiveLossLimit ?? 3} unit="losses"
              onChange={(v) => useRealMarketStore.setState({ consecutiveLossLimit: v })}
              min={1} max={10} step={1}
            />
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: -12, marginBottom: 12 }}>
              After this many consecutive losses the engine pauses for 30 minutes.
            </div>
            <SliderInput
              label="Consecutive Loss Pause Duration" value={realStore.pauseDurationMin ?? 30} unit="min"
              onChange={(v) => useRealMarketStore.setState({ pauseDurationMin: v })}
              min={5} max={60} step={5}
            />
            <SliderInput
              label="Max Concurrent Open Trades" value={realStore.maxConcurrentTrades ?? 3} unit=""
              onChange={(v) => useRealMarketStore.setState({ maxConcurrentTrades: v })}
              min={1} max={10} step={1}
            />
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: -12, marginBottom: 12 }}>
              Maximum number of trades that can be open simultaneously.
            </div>
            <SliderInput
              label="Daily Loss Stop (0 = off)" value={realStore.dailyLossStop ?? 0} unit="USD"
              onChange={(v) => useRealMarketStore.setState({ dailyLossStop: v })}
              min={0} max={500} step={5}
            />
            <SliderInput
              label="Daily Profit Target (0 = off)" value={realStore.dailyProfitTarget ?? 0} unit="USD"
              onChange={(v) => useRealMarketStore.setState({ dailyProfitTarget: v })}
              min={0} max={500} step={5}
            />
          </div>

          {/* Duration Engine */}
          <div className="glass" style={{ padding: '24px' }}>
            <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 8 }}>
              <SlidersHorizontal size={18} color="var(--cyan)" />
              Duration Engine
            </h2>
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Expiry Mode</span>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {['AUTO', '1m', '2m', '3m', '5m', '10m', '15m'].map(val => (
                  <button
                    key={val}
                    onClick={() => realStore.setExpiry ? realStore.setExpiry(val) : useRealMarketStore.setState({ expiry: val })}
                    style={{
                      padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                      background: (realStore.expiry || 'AUTO') === val ? 'var(--cyan)' : 'rgba(255,255,255,0.05)',
                      color: (realStore.expiry || 'AUTO') === val ? '#000' : 'var(--text-muted)',
                      border: (realStore.expiry || 'AUTO') === val ? 'none' : '1px solid var(--border)',
                      transition: 'all 0.2s'
                    }}
                  >
                    {val}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 8 }}>
                AUTO mode uses T50/VIX-scaled algorithm: high volatility → short duration, low volatility → long duration.
              </div>
            </div>
            <SliderInput
              label="K_max Hard Exit (seconds)" value={realStore.kMaxExit ?? 180} unit="sec"
              onChange={(v) => useRealMarketStore.setState({ kMaxExit: v })}
              min={30} max={600} step={15}
            />
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: -12, marginBottom: 12 }}>
              Maximum time to hold any single trade before force-selling.
            </div>
          </div>

          {/* News & Session Controls */}
          <div className="glass" style={{ padding: '24px' }}>
            <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Shield size={18} color="var(--crimson)" />
              News & Kill Switch
            </h2>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Auto-Block During News Events</div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Block affected currency pairs ±10/5 min around high-impact news</div>
              </div>
              <button
                onClick={() => useRealMarketStore.setState(s => ({ newsBlockEnabled: !(s.newsBlockEnabled ?? true) }))}
                style={{
                  width: 48, height: 26, borderRadius: 13,
                  background: (realStore.newsBlockEnabled ?? true) ? 'var(--cyan)' : 'var(--border)',
                  border: 'none', position: 'relative', cursor: 'pointer',
                  transition: 'background 0.2s'
                }}
              >
                <div style={{
                  width: 20, height: 20, borderRadius: '50%', background: '#fff',
                  position: 'absolute', top: 3,
                  left: (realStore.newsBlockEnabled ?? true) ? 25 : 3,
                  transition: 'left 0.2s',
                }} />
              </button>
            </div>
            <SliderInput
              label="News Pre-Block Window" value={realStore.newsPreBlockMin ?? 10} unit="min"
              onChange={(v) => useRealMarketStore.setState({ newsPreBlockMin: v })}
              min={5} max={30} step={5}
            />
            <SliderInput
              label="News Post-Block Window" value={realStore.newsPostBlockMin ?? 5} unit="min"
              onChange={(v) => useRealMarketStore.setState({ newsPostBlockMin: v })}
              min={1} max={15} step={1}
            />
            <div style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--crimson)' }}>Kill Switch</div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{realStore.killSwitchActive ? 'Active — all trading halted' : 'Inactive'}</div>
                </div>
                <button
                  onClick={() => useRealMarketStore.getState().toggleKillSwitch()}
                  style={{
                    padding: '8px 20px', borderRadius: 8, fontWeight: 700, fontSize: 12,
                    background: realStore.killSwitchActive ? 'var(--success)' : 'var(--crimson)',
                    color: '#fff', border: 'none', cursor: 'pointer',
                    boxShadow: realStore.killSwitchActive ? '0 4px 12px rgba(0,230,118,0.2)' : '0 4px 12px rgba(255,68,79,0.2)'
                  }}
                >
                  {realStore.killSwitchActive ? 'RESET KILL SWITCH' : 'ENGAGE KILL SWITCH'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
      )}

      
    </div>
  );
}

