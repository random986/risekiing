/* ═══ Layout — Main app shell with Top Header ═══ */
import { Outlet } from 'react-router-dom';
import NoticeStrip, { NOTICE_STRIP_HEIGHT } from './NoticeStrip';
import Header from './Header';

const HEADER_TOP = NOTICE_STRIP_HEIGHT;

export default function Layout() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw', background: 'var(--bg-primary)', overflow: 'hidden' }}>
      <NoticeStrip />

      {/* Top Navigation Header */}
      <Header bannerOffset={HEADER_TOP} />

      {/* Main Content Area */}
      <main style={{
        flex: 1,
        overflow: 'auto',
        padding: '16px',
        paddingTop: `${150 + NOTICE_STRIP_HEIGHT}px`,
        paddingBottom: '120px',
        background: 'var(--bg-primary)',
        width: '100%',
      }}>
        <Outlet />
      </main>
    </div>
  );
}
