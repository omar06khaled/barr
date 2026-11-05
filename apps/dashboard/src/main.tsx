import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { isSignedIn, signOut } from './api';
import { I18nProvider, useI18n } from './i18n';
import { Login } from './pages/Login';
import { Today } from './pages/Today';
import { Families, FamilyDetail } from './pages/Families';
import { Schedule } from './pages/Schedule';
import { Staff } from './pages/Staff';
import { Payments } from './pages/Payments';
import { Audit, Helpline, Jobs, Metrics, Settings } from './pages/Ops';
import './styles.css';

function Shell() {
  const { s, toggle } = useI18n();
  const [signedIn, setSignedIn] = useState(isSignedIn());
  if (!signedIn) return <Login onDone={() => setSignedIn(true)} />;
  const links: [string, string][] = [['/', s.nav.today], ['/families', s.nav.families], ['/schedule', s.nav.schedule], ['/staff', s.nav.staff], ['/payments', s.nav.payments], ['/helpline', s.nav.helpline], ['/settings', s.nav.settings], ['/audit', s.nav.audit], ['/jobs', s.nav.jobs], ['/metrics', s.nav.metrics]];
  return (
    <div className="layout">
      <nav className="sidebar" aria-label="Main">
        <div className="brand">Barr · بر</div>
        {links.map(([to, label]) => <NavLink key={to} to={to} end={to === '/'}>{label}</NavLink>)}
        <div className="foot">
          <button onClick={toggle}>{s.common.language}</button>
          <button onClick={() => { signOut(); setSignedIn(false); }}>{s.common.signOut}</button>
        </div>
      </nav>
      <main>
        <Routes>
          <Route path="/" element={<Today />} />
          <Route path="/families" element={<Families />} />
          <Route path="/families/:id" element={<FamilyDetail />} />
          <Route path="/schedule" element={<Schedule />} />
          <Route path="/staff" element={<Staff />} />
          <Route path="/payments" element={<Payments />} />
          <Route path="/helpline" element={<Helpline />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/audit" element={<Audit />} />
          <Route path="/jobs" element={<Jobs />} />
          <Route path="/metrics" element={<Metrics />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode><I18nProvider><BrowserRouter><Shell /></BrowserRouter></I18nProvider></StrictMode>,
);
