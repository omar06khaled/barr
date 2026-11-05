import { useState } from 'react';
import { api, setSession } from '../api';
import { useI18n } from '../i18n';

export function Login({ onDone }: { onDone: () => void }) {
  const { s, toggle } = useI18n();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const send = async () => { setErr(null); try { await api('/auth/otp/request', { method: 'POST', body: { phone } }); setSent(true); } catch (e: any) { setErr(e.code); } };
  const verify = async () => {
    setErr(null);
    try {
      const r = await api<any>('/auth/otp/verify', { method: 'POST', body: { phone, code, deviceName: 'dashboard' } });
      if (!r.user.roles.some((x: string) => x === 'admin' || x === 'coordinator')) { setErr('not_dashboard_staff'); return; }
      setSession(r.accessToken, r.refreshToken);
      onDone();
    } catch (e: any) { setErr(e.code); }
  };
  return (
    <div style={{ maxWidth: 380, margin: '10vh auto' }} className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}><h1>{s.login.title}</h1><button className="secondary" onClick={toggle}>{s.common.language}</button></div>
      <p className="muted">{s.login.staffOnly}</p>
      <div className="stack">
        <label>{s.login.phone}<br /><input dir="ltr" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+20 10 0000 0001" style={{ width: '100%' }} /></label>
        {!sent ? <button onClick={send} disabled={phone.length < 8}>{s.login.send}</button> : (
          <>
            <label>{s.login.code}<br /><input dir="ltr" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} style={{ width: '100%' }} /></label>
            <button onClick={verify} disabled={code.length !== 6}>{s.login.verify}</button>
          </>
        )}
        {err && <p className="error" role="alert">{err}</p>}
      </div>
    </div>
  );
}
