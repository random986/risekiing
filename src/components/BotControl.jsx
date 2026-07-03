import { useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Play, Square, Zap, Link2, Pause } from 'lucide-react';
import { motion } from 'framer-motion';
import useTradeStore from '../store/useTradeStore';
import useConnectionStore from '../store/useConnectionStore';
import useConfigStore from '../store/useConfigStore';
import tradeEngine from '../lib/enhancedTradeEngine';
import { resetGlobalRiskMatrix } from '../lib/apexMatrixEngine.js';
import { getConservativeEngineOverrides } from '../lib/tradeAnalytics.js';
import derivWS from '../lib/derivWS';
import { MARKET_LABELS } from '../lib/marketScanner';
import useAccountStore from '../store/useAccountStore';
import toast from 'react-hot-toast';

export default function BotControl() {
  const navigate = useNavigate();
  const botRunning = useTradeStore(s => s.botRunning);
  const botPaused = useTradeStore(s => s.botPaused);
  const botStatus = useTradeStore(s => s.botStatus);
  const stopReason = useTradeStore(s => s.stopReason);
  const status = useConnectionStore(s => s.status);
  const activeMarket = useConnectionStore(s => s.activeMarket);
  const account = useConnectionStore(s => s.account);
  const config = useConfigStore();
  
  const setBotRunning = useTradeStore(s => s.setBotRunning);
  const setBotPaused = useTradeStore(s => s.setBotPaused);
  const setStopReason = useTradeStore(s => s.setStopReason);
  const setActiveMarket = useConnectionStore(s => s.setActiveMarket);
  const addOrUpdateTrade = useTradeStore(s => s.addOrUpdateTrade);
  const resetSession = useTradeStore(s => s.resetSession);
  const clearPersistedLog = useTradeStore(s => s.clearPersistedLog);
  const setBotStatus = useTradeStore(s => s.setBotStatus);
  const setLiveAnalysisBoard = useTradeStore(s => s.setLiveAnalysisBoard);

  useEffect(() => {
    tradeEngine.onLiveAnalysisUpdate = (payload) => setLiveAnalysisBoard(payload);
    return () => {
      if (tradeEngine.onLiveAnalysisUpdate) tradeEngine.onLiveAnalysisUpdate = null;
    };
  }, [setLiveAnalysisBoard]);

  useEffect(() => {
    if (botRunning) {
      tradeEngine.onTradeUpdate = (trade) => addOrUpdateTrade(trade);
      tradeEngine.onBotStop = (reason) => {
        if (reason && reason !== 'User stopped') toast.error(reason, { duration: 4000, position: 'top-center' }); 
        setStopReason(reason); 
        setBotStatus(''); 
        setBotRunning(false);
      };
      tradeEngine.onMarketSwitch = (market) => setActiveMarket(market);
      tradeEngine.onStatusChange = (statusStr) => {
        setBotStatus(statusStr);
        if (statusStr.includes('??') || statusStr.includes('??') || statusStr.includes('CIRCUIT BREAKER')) {
          toast(statusStr, { icon: statusStr.includes('??') ? '??' : '??', duration: 4000, position: 'top-center' });
        }
      };
    }
  }, [botRunning, addOrUpdateTrade, setStopReason, setBotStatus, setActiveMarket, setBotRunning]);

  useEffect(() => {
    if (botRunning) {
      const baseStake = config.minStakeOnly
        ? Math.max(0.35, Number(config.baseStake) || 0.35)
        : config.baseStake;

      tradeEngine.updateConfig({
        strategy: config.strategy,
        baseStake,
        maxSteps: config.maxSteps,
        maxMartingaleStep: config.maxMartingaleStep ?? config.maxSteps ?? 0,
        recoveryPayoutRate: config.recoveryPayoutRate ?? 0.92,
        martMultiplier: config.martMultiplier,
        martingaleHoldAfterStep: config.martingaleHoldAfterStep ?? 0,
        recoveryEnabled: config.recoveryEnabled,
        resetMartingaleOnWin: config.resetMartingaleOnWin !== false,
        antiMartEnabled: config.antiMartEnabled,
        antiMartMultiplier: config.antiMartMultiplier,
        switchAfterLosses: config.switchAfterLosses,
        stopLoss: config.stopLoss || 0,
        takeProfit: config.takeProfit || 0,
        takeProfitType: config.takeProfitType || 'currency',
        cooldownMs: config.cooldownMs,
        entryConfirmEnabled: config.entryConfirmEnabled !== false,
        entryConfirmRandom: config.entryConfirmRandom !== false,
        entryConfirmMinSec: config.entryConfirmMinSec ?? 20,
        entryConfirmMaxSec: config.entryConfirmMaxSec ?? 25,
        entryConfirmMs: config.entryConfirmMs ?? 0,
        minConfidence: config.minConfidence,
        virtualLossesToWait: config.virtualLossesToWait,
        autoSwitchMarkets: config.autoSwitchMarkets,
        maxStakeCap: config.maxStakeCap,
        maxStakeMultiplier: config.maxStakeMultiplier,
        maxTradesPerMinute: config.maxTradesPerMinute,
        recoveryLossTarget: config.recoveryLossTarget,
        maxLossStreak: config.maxLossStreak ?? 0,
        maxLossStreakStopEnabled: config.maxLossStreakStopEnabled === true,
        lossStreakPauseMs: config.lossStreakPauseMs ?? 12000,
        entryGateMinWin: config.entryGateMinWin ?? 49,
        entryGateTightenPerLoss: config.entryGateTightenPerLoss ?? 2,
        entryGateMinConv: config.entryGateMinConv ?? 45,
        entryGateMinEdge: config.entryGateMinEdge ?? 102,
        entryGateMinOppEnd: config.entryGateMinOppEnd ?? 4,
        entryGateMinOppStreak: config.entryGateMinOppStreak ?? 4,
        freezeMartingaleAfterLosses: config.freezeMartingaleAfterLosses,
        maxMartingaleStepWhenLosing: config.maxMartingaleStepWhenLosing,
        rollingWinRateKillEnabled: config.rollingWinRateKillEnabled === true,
        rollingWinRateFloor: config.rollingWinRateFloor ?? 48,
        rollingWinRateWindow: config.rollingWinRateWindow ?? 50,
        rollingWinRateMinTrades: config.rollingWinRateMinTrades ?? 20,
        sessionDrawdownStopPct: config.sessionDrawdownStopPct ?? 0,
        cascadePauseAt: config.cascadePauseAt ?? 0,
        cascadeFreezeAt: config.cascadeFreezeAt ?? 0,
        cascadeStopAt: config.cascadeStopAt ?? 0,
        cascadePauseMs: config.cascadePauseMs ?? 8000,
        conservativeMode: config.conservativeMode === true,
        minStakeOnly: config.minStakeOnly === true,
        requireExhaustionGate: config.requireExhaustionGate !== false,
        invertTradeDirection: config.invertTradeDirection === true,
        ...getConservativeEngineOverrides(config)
      });
    }
  }, [botRunning, config]);

  const handleToggle = useCallback(() => {
    resetGlobalRiskMatrix();
    if (botRunning) {
      tradeEngine.stop('User stopped');
      setBotRunning(false);
      setBotPaused(false);
    } else {
      if (status !== 'authorized') return;
      resetSession();

      tradeEngine.onTradeUpdate = (trade) => addOrUpdateTrade(trade);
      tradeEngine.onHybridSoftReset = () => {
        resetSession();
        if (clearPersistedLog) clearPersistedLog();
      };
      tradeEngine.onBotStop = (reason) => {
        if (reason && reason !== 'User stopped') toast.error(reason, { duration: 4000, position: 'top-center' }); setStopReason(reason); setBotStatus(''); };
      tradeEngine.onMarketSwitch = (market) => setActiveMarket(market);
      tradeEngine.onStatusChange = (statusStr) => {
        setBotStatus(statusStr);
        if (statusStr.includes('??') || statusStr.includes('??') || statusStr.includes('CIRCUIT BREAKER')) {
          toast(statusStr, { icon: statusStr.includes('??') ? '??' : '??', duration: 4000, position: 'top-center' });
        }
      };

      const conservative = getConservativeEngineOverrides(config);
      const baseStake = config.minStakeOnly
        ? Math.max(0.35, Number(config.baseStake) || 0.35)
        : config.baseStake;

      tradeEngine.start({
        strategy: config.strategy,
        baseStake,
        maxSteps: config.maxSteps,
        hybridMaxSteps: config.hybridMaxSteps,
        hybridTakeProfit: config.hybridTakeProfit,
        hybridStopLossCurrency: config.hybridStopLossCurrency,
        hybridStopLossSteps: config.hybridStopLossSteps,
        maxMartingaleStep: (config.maxMartingaleStep > 0) ? config.maxMartingaleStep : (config.maxSteps || 0),
        recoveryPayoutRate: config.recoveryPayoutRate ?? 0.92,
        martMultiplier: config.martMultiplier,
        martingaleHoldAfterStep: config.martingaleHoldAfterStep ?? 0,
        recoveryEnabled: config.recoveryEnabled,
        resetMartingaleOnWin: config.resetMartingaleOnWin !== false,
        antiMartEnabled: config.antiMartEnabled,
        antiMartMultiplier: config.antiMartMultiplier,
        switchAfterLosses: config.switchAfterLosses,
        stopLoss: config.stopLoss || 0,
        takeProfit: config.takeProfit || 0,
        takeProfitType: config.takeProfitType || 'currency',
        cooldownMs: config.cooldownMs,
        entryConfirmEnabled: config.entryConfirmEnabled !== false,
        entryConfirmRandom: config.entryConfirmRandom !== false,
        entryConfirmMinSec: config.entryConfirmMinSec ?? 20,
        entryConfirmMaxSec: config.entryConfirmMaxSec ?? 25,
        entryConfirmMs: config.entryConfirmMs ?? 0,
        minConfidence: config.minConfidence,
        virtualLossesToWait: config.virtualLossesToWait,
        autoSwitchMarkets: config.autoSwitchMarkets,
        maxStakeCap: config.maxStakeCap,
        maxStakeMultiplier: config.maxStakeMultiplier,
        maxTradesPerMinute: config.maxTradesPerMinute,
        recoveryLossTarget: config.recoveryLossTarget,
        maxLossStreak: config.maxLossStreak ?? 0,
        maxLossStreakStopEnabled: config.maxLossStreakStopEnabled === true,
        lossStreakPauseMs: config.lossStreakPauseMs ?? 12000,
        entryGateMinWin: config.entryGateMinWin ?? 49,
        entryGateTightenPerLoss: config.entryGateTightenPerLoss ?? 2,
        entryGateMinConv: config.entryGateMinConv ?? 45,
        entryGateMinEdge: config.entryGateMinEdge ?? 102,
        entryGateMinOppEnd: config.entryGateMinOppEnd ?? 4,
        entryGateMinOppStreak: config.entryGateMinOppStreak ?? 4,
        freezeMartingaleAfterLosses: config.freezeMartingaleAfterLosses,
        maxMartingaleStepWhenLosing: config.maxMartingaleStepWhenLosing,
        rollingWinRateKillEnabled: config.rollingWinRateKillEnabled === true,
        rollingWinRateFloor: config.rollingWinRateFloor ?? 48,
        rollingWinRateWindow: config.rollingWinRateWindow ?? 50,
        rollingWinRateMinTrades: config.rollingWinRateMinTrades ?? 20,
        sessionDrawdownStopPct: config.sessionDrawdownStopPct ?? 0,
        cascadePauseAt: config.cascadePauseAt ?? 0,
        cascadeFreezeAt: config.cascadeFreezeAt ?? 0,
        cascadeStopAt: config.cascadeStopAt ?? 0,
        cascadePauseMs: config.cascadePauseMs ?? 8000,
        conservativeMode: config.conservativeMode === true,
        minStakeOnly: config.minStakeOnly === true,
        requireExhaustionGate: config.requireExhaustionGate !== false,
        invertTradeDirection: config.invertTradeDirection === true,
        adaptiveInvertDirection: config.adaptiveInvertDirection !== false,
        timeStopMs: config.timeStopMs || 0,
        // autoSwitchMarkets is only honoured for RANDOM_PICKER; gate it here too
        autoSwitchMarkets: config.strategy === 'RANDOM_PICKER'
          ? (config.autoSwitchMarkets !== false)
          : false,
        ...conservative,
      });
      setBotRunning(true);
    }
  }, [botRunning, status, config, setBotRunning, setStopReason, setActiveMarket, addOrUpdateTrade, resetSession, setBotStatus]);

  const canStart = status === 'authorized' && !botRunning;

  const buttonJSX = status !== 'authorized' ? (
    <motion.button
      whileTap={{ scale: 0.98 }}
      onClick={() => navigate('/settings')}
      style={{
        width: '100%', padding: '14px 0', borderRadius: 12, border: 'none',
        cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
        background: 'var(--cyan)', color: '#000', fontSize: 16, fontWeight: 700,
        boxShadow: '0 0 30px rgba(0, 167, 158, 0.4)',
      }}
    >
      <Link2 size={20} />
      CONNECT ACCOUNT
    </motion.button>
  ) : (
    <div style={{ display: 'flex', gap: 10, width: '100%' }}>
      {botRunning ? (
        <>
          <motion.button
            whileTap={{ scale: 0.98 }}
            onClick={() => {
              if (botPaused) {
                tradeEngine.resume();
                setBotPaused(false);
              } else {
                tradeEngine.pause();
                setBotPaused(true);
              }
            }}
            style={{
              flex: 1, padding: '14px 0', borderRadius: 12, border: 'none',
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
              background: botPaused ? 'var(--cyan)' : 'var(--amber)', 
              color: '#000', fontSize: 16, fontWeight: 800, letterSpacing: '1px',
              transition: 'background 0.3s'
            }}
          >
            {botPaused ? <><Play size={18} fill="#000" /> RESUME</> : <><Pause size={18} fill="#000" /> PAUSE</>}
          </motion.button>
          <motion.button
            whileTap={{ scale: 0.98 }}
            onClick={handleToggle}
            style={{
              flex: 1, padding: '14px 0', borderRadius: 12, border: 'none',
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
              background: 'var(--crimson)', 
              color: '#fff', fontSize: 16, fontWeight: 800, letterSpacing: '1px',
              transition: 'background 0.3s'
            }}
          >
            <Square size={18} fill="#fff" /> STOP TRADING
          </motion.button>
        </>
      ) : (
        <motion.button
          whileTap={{ scale: 0.98 }}
          onClick={handleToggle}
          style={{
            width: '100%', padding: '14px 0', borderRadius: 12, border: 'none',
            cursor: canStart ? 'pointer' : 'not-allowed',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
            background: 'var(--cyan)', 
            color: '#000', fontSize: 16, fontWeight: 800, letterSpacing: '1px',
            transition: 'background 0.3s'
          }}
        >
          <Play size={18} fill="#000" /> START TRADING
        </motion.button>
      )}
    </div>
  );

  return (
    <>
      {/* Desktop: normal flow inside glass card */}
      <div className="hidden md:flex glass" style={{ padding: '16px 20px', flexDirection: 'column', gap: 12 }}>
        {buttonJSX}
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
            {botRunning && (
              <>
                {activeMarket && (
                  <>
                    <Zap size={12} color="var(--cyan)" />
                    <span className="font-data" style={{ color: 'var(--cyan)', fontWeight: 600 }}>{MARKET_LABELS[activeMarket] || activeMarket}</span>
                    <span>• </span>
                  </>
                )}
                <span>{botStatus || (config.strategy === 'BOTH5' ? 'Scanning Over/Under…' : 'Scanning…')}</span>
              </>
            )}
            {!botRunning && stopReason && (
              <span style={{ color: 'var(--amber)', fontWeight: 600 }}>{stopReason}</span>
            )}
            {!botRunning && !stopReason && status === 'authorized' && (
              <span style={{ color: 'var(--text-secondary)' }}>Ready to execute strategy.</span>
            )}
            {status !== 'authorized' && (
              <span style={{ color: 'var(--text-muted)' }}>Bot is currently offline.</span>
            )}
          </div>
        </div>
      </div>

      {/* Mobile: floating at bottom center */}
      <div className="md:hidden" style={{
        position: 'fixed', bottom: 16, left: '50%', transform: 'translateX(-50%)',
        width: '90%', maxWidth: 360, zIndex: 200,
      }}>
        {buttonJSX}
      </div>
    </>
  );
}

