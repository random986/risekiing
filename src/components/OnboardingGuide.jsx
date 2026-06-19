/* ═══ OnboardingGuide — First-time user walkthrough ═══ */
import { useState, useEffect } from 'react';
import { X, ChevronRight, ChevronLeft, Zap, Shield, Radar, Printer, Settings2, ArrowRight } from 'lucide-react';

const ONBOARDING_KEY = 'derivprinter_onboarding_done';

const STEPS = [
  {
    icon: Printer,
    title: 'Welcome to Derivprinter',
    subtitle: 'Your Automated Multi-Market Trading Terminal',
    content: 'Derivprinter is an advanced algorithmic platform for both Synthetic Indices and Real Markets (Forex, Metals, OTC). Execute high-speed digit predictions on Synthetics or deploy dynamic duration strategies on Real Markets.',
    tip: 'This gives you hedged exposure on every single tick.',
    color: '#ff444f',
  },
  {
    icon: Zap,
    title: 'Dual-Engine Capabilities',
    subtitle: 'Synthetics & Real Markets',
    content: 'Switch seamlessly between Synthetic Markets (Even/Odd, Over/Under) and Real Markets (Rise/Fall, Accumulators). Use the toggle at the top of the app to change environments. Each has its own dedicated algorithms.',
    tip: 'Your Deriv account covers both environments. Make sure you use a Demo account first!',
    color: '#00e676',
  },
  {
    icon: Radar,
    title: 'Advanced Sifting Matrix',
    subtitle: 'Live Market Intelligence',
    content: 'Whether analyzing digit distribution in Synthetics or Volatility/Trend metrics (TII, Alpha) in Real Markets, our Sifting Matrix automatically ranks and selects the best assets for your configured strategy.',
    tip: 'Leave the engine on AUTO to let the bot pick the optimal market dynamically.',
    color: '#00a8ff',
  },
  {
    icon: Shield,
    title: 'Risk Management',
    subtitle: 'Protect your capital',
    content: 'Set Stop Loss and Take Profit in Settings to auto-stop the bot when limits are hit. Set them to 0 for no limit. Martingale recovery doubles your stake after a loss to recover — use with caution.',
    tip: 'Start with Demo account first to learn how the system behaves.',
    color: '#ff8c00',
  },
  {
    icon: Settings2,
    title: 'You\'re Ready!',
    subtitle: 'Start trading in seconds',
    content: 'Head to Settings to configure your base stake, strategy, and risk guardrails. Then go to the Dashboard and connect your Deriv account to begin.',
    tip: 'You can always access this guide again from the Settings page.',
    color: '#ff444f',
  },
];

export default function OnboardingGuide({ onComplete }) {
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState(0);
  const [fadeIn, setFadeIn] = useState(false);

  useEffect(() => {
    const done = sessionStorage.getItem(ONBOARDING_KEY);
    if (done !== 'true') {
      setVisible(true);
      setTimeout(() => setFadeIn(true), 50);
    }
  }, []);

  const handleComplete = () => {
    sessionStorage.setItem(ONBOARDING_KEY, 'true');
    setFadeIn(false);
    setTimeout(() => {
      setVisible(false);
      if (onComplete) onComplete();
    }, 300);
  };

  const handleNext = () => {
    if (step < STEPS.length - 1) setStep(step + 1);
    else handleComplete();
  };

  const handlePrev = () => {
    if (step > 0) setStep(step - 1);
  };

  if (!visible) return null;

  const current = STEPS[step];
  const Icon = current.icon;
  const isLast = step === STEPS.length - 1;

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      background: 'rgba(0, 0, 0, 0.85)',
      backdropFilter: 'blur(8px)',
      zIndex: 99998,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 20,
      opacity: fadeIn ? 1 : 0,
      transition: 'opacity 0.3s ease',
    }}>
      <style>{`
        @keyframes guideSlideIn {
          from { transform: translateY(20px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
        @keyframes guidePulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.05); }
        }
      `}</style>

      <div style={{
        width: '100%', maxWidth: 480,
        background: 'linear-gradient(145deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)',
        borderRadius: 20,
        overflow: 'hidden',
        boxShadow: `0 0 80px ${current.color}22, 0 20px 60px rgba(0,0,0,0.5)`,
        animation: 'guideSlideIn 0.4s ease-out',
        border: '1px solid rgba(255,255,255,0.08)',
      }}>
        {/* Header Bar */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {STEPS.map((_, i) => (
              <div key={i} style={{
                width: i === step ? 24 : 8, height: 8,
                borderRadius: 4,
                background: i === step ? current.color : 'rgba(255,255,255,0.15)',
                transition: 'all 0.3s ease',
              }} />
            ))}
          </div>
          <button
            onClick={handleComplete}
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'rgba(255,255,255,0.4)', padding: 4,
              display: 'flex', alignItems: 'center',
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div key={step} style={{
          padding: '32px 28px 24px',
          animation: 'guideSlideIn 0.3s ease-out',
        }}>
          {/* Icon */}
          <div style={{
            width: 64, height: 64, borderRadius: 16,
            background: `${current.color}15`,
            border: `1px solid ${current.color}30`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            marginBottom: 20,
            animation: 'guidePulse 2s ease-in-out infinite',
          }}>
            <Icon size={30} color={current.color} />
          </div>

          {/* Title */}
          <h2 style={{
            fontSize: 22, fontWeight: 800, color: '#fff',
            fontFamily: "'Syne', sans-serif",
            marginBottom: 4,
          }}>
            {current.title}
          </h2>
          <p style={{
            fontSize: 13, color: current.color,
            fontWeight: 600, marginBottom: 16,
            letterSpacing: '0.5px',
          }}>
            {current.subtitle}
          </p>

          {/* Body */}
          <p style={{
            fontSize: 14, color: 'rgba(255,255,255,0.75)',
            lineHeight: 1.7, marginBottom: 16,
          }}>
            {current.content}
          </p>

          {/* Tip */}
          <div style={{
            padding: '12px 14px',
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 10,
            fontSize: 12, color: 'rgba(255,255,255,0.55)',
            lineHeight: 1.6,
          }}>
            💡 <strong style={{ color: 'rgba(255,255,255,0.8)' }}>Tip:</strong> {current.tip}
          </div>
        </div>

        {/* Footer Buttons */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 28px 24px',
          gap: 12,
        }}>
          {step > 0 ? (
            <button
              onClick={handlePrev}
              style={{
                display: 'flex', alignItems: 'center', gap: 4,
                background: 'transparent', border: '1px solid rgba(255,255,255,0.1)',
                color: 'rgba(255,255,255,0.6)', padding: '10px 18px',
                borderRadius: 10, cursor: 'pointer', fontSize: 13, fontWeight: 600,
              }}
            >
              <ChevronLeft size={16} /> Back
            </button>
          ) : (
            <button
              onClick={handleComplete}
              style={{
                background: 'transparent', border: 'none',
                color: 'rgba(255,255,255,0.4)', cursor: 'pointer',
                fontSize: 12, fontWeight: 500, padding: '10px 0',
              }}
            >
              Skip guide
            </button>
          )}
          <button
            onClick={handleNext}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              background: `linear-gradient(135deg, ${current.color} 0%, ${current.color}cc 100%)`,
              color: '#fff', border: 'none', borderRadius: 10,
              padding: '12px 24px', fontSize: 14, fontWeight: 700,
              cursor: 'pointer',
              boxShadow: `0 4px 20px ${current.color}40`,
              transition: 'transform 0.2s, box-shadow 0.2s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'translateY(-1px)';
              e.currentTarget.style.boxShadow = `0 6px 25px ${current.color}50`;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'translateY(0)';
              e.currentTarget.style.boxShadow = `0 4px 20px ${current.color}40`;
            }}
          >
            {isLast ? (
              <>Get Started <ArrowRight size={16} /></>
            ) : (
              <>Next <ChevronRight size={16} /></>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
