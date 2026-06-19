import React, { useEffect, useState, useRef } from 'react';
import { Wallet, TrendingUp, Activity, BarChart3, Play, Square, Link2, Zap, AlertTriangle, ShieldAlert } from 'lucide-react';
import { useRealMarketStore, ALL_MARKETS, MARKET_LABELS } from '../stores/useRealMarketStore';
import { engine } from '../lib/realMarketEngine';
import derivWS from '../lib/derivWS';
import StatCard from '../components/StatCard';
import useConnectionStore from '../store/useConnectionStore';
import useAccountStore from '../store/useAccountStore';
import useTradeStore from '../store/useTradeStore';
import { motion } from 'framer-motion';
import { fmt, fmtMoney, num } from '../lib/format';
import RealMarketTradeBoard from '../components/RealMarketTradeBoard';

export default function RealMarketsTab() {
  // Use individual selectors to avoid subscribing to the whole store (prevents React #185)
  const markets = useRealMarketStore(s => s.markets);
  const selectedMarket = useRealMarketStore(s => s.selectedMarket);
  const contractType = useRealMarketStore(s => s.contractType);
  const baseStake = useRealMarketStore(s => s.baseStake);
  const mcsFilter = useRealMarketStore(s => s.mcsFilter);
  const autoTrade = useRealMarketStore(s => s.autoTrade);
  const engineStatus = useRealMarketStore(s => s.engineStatus);
  const engineAnalysis = useRealMarketStore(s => s.engineAnalysis);
  const currentTrade = useRealMarketStore(s => s.currentTrade);
  const tickFeed = useRealMarketStore(s => s.tickFeed);
  const dailyPnL = useRealMarketStore(s => s.dailyPnL);
  const sessionWins = useRealMarketStore(s => s.sessionWins);
  const sessionLosses = useRealMarketStore(s => s.sessionLosses);
  const killSwitchActive = useRealMarketStore(s => s.killSwitchActive);
  const tradeHistory = useRealMarketStore(s => s.tradeHistory);
  const expiry = useRealMarketStore(s => s.expiry);
  const tradeOpportunities = useRealMarketStore(s => s.tradeOpportunities);
  const executionQueue = useRealMarketStore(s => s.executionQueue);
  const openTrades = useRealMarketStore(s => s.openTrades);

  // Actions (stable references)
  const setSelectedMarket = useRealMarketStore(s => s.setSelectedMarket);
  const setContractType = useRealMarketStore(s => s.setContractType);
  const setBaseStake = useRealMarketStore(s => s.setBaseStake);
  const setMcsFilter = useRealMarketStore(s => s.setMcsFilter);
  const setAutoTrade = useRealMarketStore(s => s.setAutoTrade);
  const setEngineStatus = useRealMarketStore(s => s.setEngineStatus);
  const pushTickFeed = useRealMarketStore(s => s.pushTickFeed);
  const resetSession = useRealMarketStore(s => s.resetSession);

  const balance = useConnectionStore(s => s.balance);
  const currency = useConnectionStore(s => s.currency);
  const status = useConnectionStore(s => s.status);
  
  const [now, setNow] = useState(new Date());
  const [durationMode, setDurationMode] = useState(expiry === 'AUTO' ? 'SUGGESTED' : 'MANUAL');
  
  const setExpiry = useRealMarketStore(s => s.setExpiry);
  const prevSuggestRef = useRef(null);

  const activeMarketSym = selectedMarket;
  const mData = markets[activeMarketSym] || {};
  const liveMarketCount = Object.values(markets).filter(
    m => !m.isClosed && (num(m.tickCount) > 0 || num(m.bid) > 0)
  ).length;


  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // suggested duration toast notifier
  useEffect(() => {
    if (durationMode !== 'SUGGESTED' || !mData?.suggestedDuration) return;
    
    const current = mData.suggestedDuration.computed;
    const prev = prevSuggestRef.current;
    
    if (prev !== null && prev !== current) {
      const isNews = mData.news?.warning;
      if (isNews && current < prev) {
        import('react-hot-toast').then(({ toast }) => {
          toast.dismiss();
          toast(`Suggested duration shortened: ${prev}m → ${current}m (${mData.news.event || 'news'} in ${fmt(mData.news.minsAway, 0)} min)`, {
            icon: '⚠️',
            style: { border: '1px solid var(--amber)', background: 'rgba(255, 193, 7, 0.1)', color: '#fff', fontSize: '12px' }
          });
        });
      } else if (current > prev) {
        import('react-hot-toast').then(({ toast }) => {
          toast.dismiss();
          toast(`Session quality shifted — suggestion extended to ${current}m (quieter market)`, {
            icon: '🌐',
            style: { border: '1px solid var(--cyan)', background: 'rgba(0, 229, 255, 0.1)', color: '#fff', fontSize: '12px' }
          });
        });
      }
    }
    
    prevSuggestRef.current = current;
  }, [mData?.suggestedDuration?.computed, durationMode, mData?.news]);

  // Initialize engine on page load/mount
  useEffect(() => {
    const activeAccount = useAccountStore.getState().accounts.find(a => a.id === useAccountStore.getState().activeAccountId);
    const token = activeAccount?.token || localStorage.getItem('deriv_api_token') || '';
    engine.start(token);
  }, []);

  useEffect(() => {
    engine.syncTradeOpportunities?.();
  }, [contractType, mcsFilter, selectedMarket]);

  const handleToggle = () => {
    if (autoTrade) {
      setAutoTrade(false);
      setEngineStatus('SCANNING');
      pushTickFeed('Auto-trading bot paused.', 'var(--amber)');
    } else {
      if (killSwitchActive) {
        pushTickFeed('Cannot start: Kill Switch is active.', 'var(--crimson)');
        return;
      }
      if (status !== 'authorized') {
        pushTickFeed('Cannot start: Please connect account in settings.', 'var(--crimson)');
        return;
      }
      
      // Only count P&L and loss streaks after the user explicitly starts trading.
      resetSession();
      setAutoTrade(true);
      pushTickFeed('Auto-trading bot started.', 'var(--success)');
      if (!derivWS.isReady) {
        const activeAccount = useAccountStore.getState().accounts.find(a => a.id === useAccountStore.getState().activeAccountId);
        engine.ensureRunning(activeAccount?.token);
      }
      engine.onAutoTradeStarted();
    }
  };

  const getEngineStatusColor = () => {
    switch(engineStatus) {
      case 'IDLE': return 'var(--text-muted)';
      case 'INITIALIZING': return 'var(--text-muted)';
      case 'SCANNING': return 'var(--cyan)';
      case 'SIGNAL_FOUND': return 'var(--success)';
      case 'TRADING': return 'var(--success)';
      case 'PAUSED': return 'var(--amber)';
      case 'BLOCKED': return 'var(--crimson)';
      default: return 'var(--text-muted)';
    }
  };

  // Safe accessors for mData properties
  const mcsTotal = num(mData?.mcs?.total);
  const mcsObj = mData?.mcs ?? { trend: 0, volume: 0, spread: 0, total: 0 };
  const erVal = num(mData?.er);
  const svcVal = num(mData?.svc);
  const tickCount = num(mData?.tickCount);
  const t50Val = num(mData?.t50, 5);
  const vixVal = num(mData?.vixScaled, 0.5);
  const bidVal = num(mData?.bid);

  // Unified trade history calculation from Real Markets only
  const combinedHistory = useRealMarketStore(s => s.tradeHistory) || [];

  // Statistics calculation for the display cards from Real Markets only
  const totalWins = useRealMarketStore(s => s.sessionWins) || 0;
  const totalLosses = useRealMarketStore(s => s.sessionLosses) || 0;
  const totalTrades = combinedHistory.length;
  const totalPnL = num(useRealMarketStore(s => s.dailyPnL) || 0);
  const winRate = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) : '0.0';

  const statusColor = getEngineStatusColor();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1600, margin: '0 auto', height: '100%' }}>
      
      {/* Header & Controls */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h1 className="font-display" style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
            Real Markets
          </h1>
          <div style={{ marginTop: 6, fontSize: 11, fontWeight: 700, color: 'var(--amber)', letterSpacing: '0.5px', textTransform: 'uppercase', background: 'rgba(255, 193, 7, 0.1)', padding: '6px 12px', borderRadius: 4, display: 'inline-block', border: '1px solid rgba(255, 193, 7, 0.2)' }}>
            ⚠️ REAL MARKETS PRODUCT UNDER DEVELOPMENT. TRY WITH DEMO AND PLACE YOUR MONEY UNDER YOUR OWN RISK IF IT FAVORS YOU.
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
            


            {/* Stake Input */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginRight: 8, paddingRight: 8, borderRight: '1px solid var(--border)' }}>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Stake:</span>
              <div style={{ position: 'relative' }}>
                <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: 12 }}>$</span>
                <input
                  type="number"
                  value={baseStake}
                  onChange={(e) => setBaseStake(Number(e.target.value))}
                  step={0.5} min={0.35}
                  className="font-data"
                  style={{
                    background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 4,
                    padding: '4px 10px 4px 22px', color: 'var(--text-primary)', fontSize: 13,
                    outline: 'none', width: 88, minWidth: 88,
                  }}
                />
              </div>
            </div>

            {/* Market Selection Dropdown */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginRight: 8, paddingRight: 8, borderRight: '1px solid var(--border)' }}>
               <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Market:</span>
               <select
                 value={selectedMarket}
                 onChange={(e) => setSelectedMarket(e.target.value)}
                 className="font-data"
                 style={{
                   background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 4,
                   padding: '2px 8px', color: 'var(--text-primary)', fontSize: 12, outline: 'none', cursor: 'pointer'
                 }}
               >
                 {ALL_MARKETS.map(m => <option key={m} value={m}>{MARKET_LABELS[m] || m}</option>)}
               </select>
            </div>

            {/* Contract Type */}
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Strategy:</span>
            <button
              onClick={() => setContractType('AUTO')}
              style={{
                background: contractType === 'AUTO' ? 'var(--cyan)' : 'rgba(255,255,255,0.05)',
                border: contractType === 'AUTO' ? 'none' : '1px solid var(--border)',
                color: contractType === 'AUTO' ? '#000' : 'var(--text-muted)',
                fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 4, cursor: 'pointer', transition: 'all 0.2s'
              }}
            >
              AUTO
            </button>
            <button
              onClick={() => setContractType('RISE/FALL')}
              style={{
                background: contractType === 'RISE/FALL' ? 'var(--cyan)' : 'rgba(255,255,255,0.05)',
                border: contractType === 'RISE/FALL' ? 'none' : '1px solid var(--border)',
                color: contractType === 'RISE/FALL' ? '#000' : 'var(--text-muted)',
                fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 4, cursor: 'pointer', transition: 'all 0.2s'
              }}
            >
              RISE / FALL
            </button>
            <button
              onClick={() => setContractType('ACCUMULATOR')}
              style={{
                background: contractType === 'ACCUMULATOR' ? 'var(--cyan)' : 'rgba(255,255,255,0.05)',
                border: contractType === 'ACCUMULATOR' ? 'none' : '1px solid var(--border)',
                color: contractType === 'ACCUMULATOR' ? '#000' : 'var(--text-muted)',
                fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 4, cursor: 'pointer', transition: 'all 0.2s'
              }}
            >
              ACCUMULATORS
            </button>

            {/* MCS Filter */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 8, paddingLeft: 8, borderLeft: '1px solid var(--border)' }}>
               <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>MCS:</span>
               {[0.40, 0.60, 0.80].map(val => (
                 <button 
                   key={val}
                   onClick={() => setMcsFilter(val)}
                   style={{
                     background: mcsFilter === val ? 'var(--amber)' : 'rgba(255,255,255,0.05)',
                     border: mcsFilter === val ? 'none' : '1px solid var(--border)',
                     color: mcsFilter === val ? '#000' : 'var(--text-muted)',
                     fontSize: 11, fontWeight: 700, padding: '4px 8px', borderRadius: 4, cursor: 'pointer'
                   }}
                 >
                   {val === 0.40 ? 'LOW' : val === 0.60 ? 'MED' : 'HIGH'}
                 </button>
               ))}
            </div>

            {/* Expiry Duration Controls */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 8, paddingLeft: 8, borderLeft: '1px solid var(--border)' }}>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>⏱ Dur:</span>
              <button
                onClick={() => {
                  setDurationMode('MANUAL');
                  setExpiry('3');
                }}
                style={{
                  background: durationMode === 'MANUAL' ? 'var(--cyan)' : 'rgba(255,255,255,0.05)',
                  border: durationMode === 'MANUAL' ? 'none' : '1px solid var(--border)',
                  color: durationMode === 'MANUAL' ? '#000' : 'var(--text-muted)',
                  fontSize: 11, fontWeight: 700, padding: '4px 8px', borderRadius: 4, cursor: 'pointer'
                }}
              >
                MANUAL
              </button>
              <button
                onClick={() => {
                  setDurationMode('SUGGESTED');
                  setExpiry('AUTO');
                }}
                style={{
                  background: durationMode === 'SUGGESTED' ? 'var(--cyan)' : 'rgba(255,255,255,0.05)',
                  border: durationMode === 'SUGGESTED' ? 'none' : '1px solid var(--border)',
                  color: durationMode === 'SUGGESTED' ? '#000' : 'var(--text-muted)',
                  fontSize: 11, fontWeight: 700, padding: '4px 8px', borderRadius: 4, cursor: 'pointer'
                }}
              >
                SUGGESTED
              </button>

              {durationMode === 'MANUAL' ? (
                <div style={{ display: 'flex', gap: 2 }}>
                  {['1', '2', '3', '5', '10', '15'].map(val => (
                    <button
                      key={val}
                      onClick={() => setExpiry(val)}
                      style={{
                        background: expiry === val ? 'var(--amber)' : 'rgba(255,255,255,0.02)',
                        border: expiry === val ? 'none' : '1px solid var(--border)',
                        color: expiry === val ? '#000' : 'var(--text-secondary)',
                        fontSize: 10, fontWeight: 600, padding: '3px 6px', borderRadius: 3, cursor: 'pointer'
                      }}
                    >
                      {val}m
                    </button>
                  ))}
                </div>
              ) : (
                <div 
                  className="group relative cursor-pointer"
                  style={{
                    background: 'rgba(0, 229, 255, 0.08)',
                    border: '1px solid rgba(0, 229, 255, 0.2)',
                    color: 'var(--cyan)',
                    fontSize: 11, fontWeight: 700, padding: '4px 8px', borderRadius: 4,
                    display: 'flex', alignItems: 'center', gap: 4, position: 'relative'
                  }}
                >
                  <span>📊 Suggested: {mData?.suggestedDuration?.computed || 3}m</span>
                  
                  {/* Premium Hover Card */}
                  <div 
                    className="absolute left-1/2 bottom-full mb-2 -translate-x-1/2 hidden group-hover:block z-50 w-72 p-4 rounded-lg border border-cyan-500/20 bg-slate-950/95 backdrop-blur-md shadow-2xl text-slate-200 text-xs font-normal leading-relaxed text-left pointer-events-none transition-all duration-200"
                    style={{ minWidth: 280 }}
                  >
                    <div className="font-bold text-cyan-400 mb-1" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.5px' }}>📊 Suggester Metrics</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }} className="space-y-1">
                      <div>T50: {mData?.suggestedDuration?.T50 || '5.0'}m trend half-life</div>
                      <div>VIX: {mData?.suggestedDuration?.VIX || '0.50'} (volatility weight)</div>
                      <div style={{ color: 'var(--amber)', marginTop: 4 }}>{mData?.suggestedDuration?.reasoning || 'Session and news calibration applied'}</div>
                      <div className="border-t border-slate-800 my-1 pt-1 font-bold text-cyan-400">Past Win Rates:</div>
                      {mData?.suggestedDuration?.durationWinRates && Object.entries(mData.suggestedDuration.durationWinRates).map(([d, wr]) => (
                        <div key={d} style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span>{d}m scalp:</span>
                          <span style={{ color: '#fff', fontWeight: 700 }}>{wr}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>

          </div>
        </div>
        {autoTrade && <div className="live-dot" />}
      </div>

      {/* Engine Status Line */}
      <div className="glass" style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 16px', fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 11 }}>
        <div style={{ width: 10, height: 10, borderRadius: '50%', background: statusColor, marginTop: 4, flexShrink: 0, boxShadow: `0 0 10px ${statusColor}` }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%', minWidth: 0 }}>
          <span style={{ color: 'var(--text-muted)', letterSpacing: '0.1px', lineHeight: 1.5 }}>
            <strong style={{ color: statusColor }}>REAL MARKET ENGINE</strong>
            {' · '}Selected: <strong style={{ color: 'var(--text-primary)' }}>{MARKET_LABELS[activeMarketSym] || activeMarketSym}</strong>
            {' · '}MCS: <strong>{fmt(mcsTotal, 2)}</strong>
            {' · '}ER: <strong>{fmt(erVal, 2)}</strong>
            {' · '}SVC: <strong>{fmt(svcVal, 3)}</strong>
            {' · '}Ticks: <strong>{tickCount}/100</strong>
            {' · '}T50: <strong>{t50Val}</strong>
            {' · '}VIX: <strong>{fmt(vixVal, 2)}</strong>
            {' · '}Dur: <strong>{expiry === 'AUTO' ? `AUTO (${t50Val ? Math.round(t50Val / 2) : 3}m)` : expiry}</strong>
            {currentTrade || openTrades?.length > 0 ? (
              <>
                {' · '}Open: <strong style={{ color: 'var(--cyan)' }}>{openTrades?.length || (currentTrade ? 1 : 0)}/2</strong>
                {(currentTrade || openTrades?.[0]) ? (
                  <>
                    {' · '}Exit: <strong style={{ color: ((currentTrade || openTrades[0]).kMaxRemaining <= 10) ? 'var(--crimson)' : 'var(--cyan)' }}>
                      {(currentTrade || openTrades[0]).kMaxRemaining || 60}s
                    </strong>
                  </>
                ) : null}
              </>
            ) : null}
          </span>
          <span style={{ color: 'var(--amber)', fontSize: 10, letterSpacing: '0.2px', fontWeight: 600, wordBreak: 'break-word' }}>
            {engineAnalysis || "Awaiting tick data to begin analysis..."}
          </span>
        </div>
      </div>


      {/* Grid Layout (Stats + Feed + Bot Control | Market Heat + History) */}
      <div className="flex flex-col xl:flex-row gap-4 flex-1 min-h-0">
        
        {/* Left Column */}
        <div className="flex flex-col gap-4 xl:w-5/12 flex-shrink-0">
          
          {/* Live multi-market trade analysis — Rise / Fall / Accumulators */}
          <RealMarketTradeBoard
            opportunities={tradeOpportunities}
            executionQueue={executionQueue}
            autoTrade={autoTrade}
            contractType={contractType}
            openMarketCount={Math.max(tradeOpportunities.length, liveMarketCount)}
          />

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1 sm:gap-2">
            <StatCard icon={Wallet} label="Balance" value={`$${fmtMoney(balance)}`} sub={currency} color="var(--amber)" delay={0} />
            <StatCard icon={TrendingUp} label="Session P&L" value={`${totalPnL >= 0 ? '+' : ''}$${fmtMoney(totalPnL)}`} sub={`${totalTrades} trades`} color={totalPnL >= 0 ? 'var(--success)' : 'var(--crimson)'} delay={0.05} />
            <StatCard icon={BarChart3} label="Win Rate" value={`${winRate}%`} sub={`W:${totalWins} / L:${totalLosses}`} color="var(--cyan)" delay={0.1} />
            <StatCard icon={Activity} label="Active" value={autoTrade ? 'LIVE' : 'OFF'} sub={autoTrade ? engineStatus : 'Idle'} color={autoTrade ? 'var(--cyan)' : 'var(--text-muted)'} delay={0.15} />
          </div>

          {/* Bot Control Button */}
          <div className="glass" style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
            {status !== 'authorized' ? (
              <button 
                onClick={() => {
                  const state = useAccountStore.getState();
                  const activeAcc = state.accounts.find(a => a.id === state.activeAccountId);
                  if (activeAcc && activeAcc.token) {
                    engine.start(activeAcc.token);
                  }
                }}
                style={{ width: '100%', padding: '14px 0', borderRadius: 12, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, background: 'var(--cyan)', color: '#000', fontSize: 16, fontWeight: 700 }}
              >
                <Link2 size={20} /> CONNECT ACCOUNT
              </button>
            ) : killSwitchActive ? (
              <button onClick={() => engine.engageKillSwitch()} style={{ width: '100%', padding: '14px 0', borderRadius: 12, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, background: 'var(--crimson)', color: '#fff', fontSize: 16, fontWeight: 800, letterSpacing: '1px' }}>
                <ShieldAlert size={18} fill="#fff" /> KILL SWITCH ACTIVE — RESET
              </button>
            ) : (
              <motion.button
                whileTap={{ scale: 0.98 }}
                onClick={handleToggle}
                style={{
                  width: '100%', padding: '14px 0', borderRadius: 12, border: 'none',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                  background: autoTrade ? 'var(--crimson)' : 'var(--cyan)', 
                  color: autoTrade ? '#fff' : '#000', fontSize: 16, fontWeight: 800, letterSpacing: '1px',
                  transition: 'background 0.3s'
                }}
              >
                {autoTrade ? <><Square size={18} fill="#fff" /> STOP TRADING</> : <><Play size={18} fill="#000" /> START TRADING</>}
              </motion.button>
            )}
            <div style={{ fontSize: 13, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
              {autoTrade ? (
                <>
                  <Zap size={12} color="var(--cyan)" />
                  <span>{openTrades?.length || 0}/2 open</span>
                  <span>• </span>
                  <span>{engineStatus === 'TRADING' ? 'Trades active…' : 'Waiting for entry triggers…'}</span>
                </>
              ) : null}
              {!autoTrade && status === 'authorized' ? <span>Ranked by entry chance · only open markets shown.</span> : null}
              {status !== 'authorized' ? <span>Bot is currently offline.</span> : null}
            </div>
          </div>

          {/* Terminal Feed Removed for Real Markets */}

        </div>

        {/* Right Column */}
        <div className="flex-1 xl:w-7/12 min-h-[400px] xl:min-h-0 flex flex-col gap-4">
          
          {/* Market Heat (Inline) */}
          <div className="glass" style={{ padding: '16px 20px' }}>
            <h4 style={{ margin: '0 0 12px 0', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Market Heat</h4>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 8 }}>
              {Object.values(markets).filter(m => !m.isClosed).sort((a, b) => (b.mcs?.total ?? 0) - (a.mcs?.total ?? 0)).slice(0, 10).map((m, idx) => (
                <div key={m.symbol} style={{ padding: 8, borderRadius: 6, background: 'var(--bg-primary)', border: `1px solid ${selectedMarket === m.symbol ? 'var(--amber)' : 'var(--border)'}` }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{MARKET_LABELS[m.symbol] || m.symbol}</div>
                  <div className="font-data" style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>{num(m.bid) > 0 ? fmt(m.bid, 4) : '---'}</div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
                    <span style={{ fontSize: 9, color: num(m.er) >= 0.6 ? 'var(--success)' : num(m.er) >= 0.3 ? 'var(--amber)' : 'var(--crimson)' }}>ER {fmt(m.er, 2)}</span>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: m.routing === 'RISE/FALL' ? 'var(--success)' : m.routing === 'ACCUMULATOR' ? 'var(--cyan)' : m.routing === 'BLOCKED' ? 'var(--crimson)' : 'var(--border)' }}></span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Trade History (Merged Real + Synthetic) */}
          <div className="glass" style={{ padding: '16px 20px', flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <div style={{ display: 'flex', gap: 24 }}>
                <div>
                  <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600 }}>Total Trades</div>
                  <div className="font-data" style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{totalTrades}</div>
                </div>
                <div>
                  <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600 }}>Session P&L</div>
                  <div className="font-data" style={{ fontSize: 15, fontWeight: 700, color: totalPnL >= 0 ? 'var(--success)' : 'var(--crimson)' }}>
                    {totalPnL >= 0 ? '+' : ''}${fmtMoney(totalPnL)}
                  </div>
                </div>
              </div>
              <button onClick={() => { resetSession(); }} style={{ background: 'rgba(255,0,0,0.1)', border: '1px solid rgba(255,0,0,0.2)', color: 'var(--crimson)', padding: '4px 8px', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 700 }}>
                CLEAR
              </button>
            </div>

            <div style={{ flex: 1, overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}>
                    <th style={{ textAlign: 'left', paddingBottom: 8, fontWeight: 500 }}>Time</th>
                    <th style={{ textAlign: 'left', paddingBottom: 8, fontWeight: 500 }}>Market</th>
                    <th style={{ textAlign: 'left', paddingBottom: 8, fontWeight: 500 }}>Type</th>
                    <th style={{ textAlign: 'left', paddingBottom: 8, fontWeight: 500 }}>Dur.</th>
                    <th style={{ textAlign: 'left', paddingBottom: 8, fontWeight: 500 }}>Stake</th>
                    <th style={{ textAlign: 'right', paddingBottom: 8, fontWeight: 500 }}>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {combinedHistory.length === 0 && (
                    <tr><td colSpan={6} style={{ textAlign: 'center', padding: 24, color: 'var(--text-muted)' }}>No trades yet in this session.</td></tr>
                  )}
                  {combinedHistory.map((t, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--border)', background: t.won ? 'rgba(0,255,136,0.03)' : 'rgba(255,68,68,0.03)' }}>
                      <td style={{ padding: '8px 0', color: 'var(--text-secondary)' }}>{new Date(t.time || t.startTime || 0).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</td>
                      <td style={{ padding: '8px 0', fontWeight: 600, color: 'var(--text-primary)' }}>{MARKET_LABELS[t.market] || t.market || '—'}</td>
                      <td style={{ padding: '8px 0', color: 'var(--text-secondary)' }}>
                        <span style={{
                          padding: '1px 5px', borderRadius: 4, fontSize: 10,
                          background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border)'
                        }}>{t.direction || t.type || '—'}</span>
                      </td>
                      <td style={{ padding: '8px 0', color: 'var(--text-secondary)' }}>{t.duration || '—'}</td>
                      <td className="font-data" style={{ padding: '8px 0', color: 'var(--text-primary)' }}>${fmtMoney(t.stake)}</td>
                      <td className="font-data" style={{ padding: '8px 0', textAlign: 'right', fontWeight: 700, color: t.won ? 'var(--success)' : 'var(--crimson)' }}>
                        {t.won ? '+' : ''}${fmtMoney(t.profit != null ? t.profit : t.pnl)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          
        </div>
      </div>
    </div>
  );
}
