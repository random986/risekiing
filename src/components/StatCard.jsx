/* ═══ StatCard — Glassmorphic stat display ═══ */
import { motion } from 'framer-motion';

export default function StatCard({ icon: Icon, label, value, sub, color = 'var(--cyan)', delay = 0 }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay }}
      className="glass"
      style={{
        padding: '8px',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {Icon && <Icon size={12} color="var(--text-muted)" className="hidden sm:block" />}
        <span style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.2px', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
          {label}
        </span>
      </div>
      <div className="font-data" style={{ fontSize: 15, fontWeight: 800, color, lineHeight: 1.1 }}>
        {value}
      </div>
      {sub && (
        <span style={{ fontSize: 9, color: 'var(--text-muted)', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{sub}</span>
      )}
    </motion.div>
  );
}
