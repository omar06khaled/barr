import { createHmac } from 'node:crypto';
import { colors, formatMoney, templateMonthlyReportGenerator, type Currency, type MonthlyReportPayload, VITAL_KINDS, translate, addDays } from '@barr/shared';
import type { Sql } from '../db/pool';
import { notify } from './notifications';
import { audit } from './audit';

/** Renders HTML → PDF. Chromium is used because it shapes Arabic and handles RTL correctly. */
export interface PdfRenderer { render(html: string): Promise<Buffer> }

export class ChromiumPdfRenderer implements PdfRenderer {
  constructor(private executablePath = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium') {}
  async render(html: string) {
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({ executablePath: this.executablePath, args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'load' });
      return await page.pdf({ format: 'A4', printBackground: true, margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' } });
    } finally { await browser.close(); }
  }
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const shell = (lang: 'ar' | 'en', title: string, body: string) => `<!doctype html><html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
body{font-family:${lang === 'ar' ? "'IBM Plex Sans Arabic','Noto Naskh Arabic','DejaVu Sans',sans-serif" : "'Nunito Sans','DejaVu Sans',sans-serif"};color:${colors.inkBody};background:#fff;font-size:12pt}
h1,h2{font-family:${lang === 'ar' ? "'IBM Plex Sans Arabic',sans-serif" : "Domine,Georgia,serif"};color:${colors.green900}}
.brand{background:${colors.green900};color:${colors.paper};padding:12px 16px;border-radius:8px}
table{width:100%;border-collapse:collapse;margin-top:12px}th,td{border-bottom:1px solid ${colors.sand};padding:8px;text-align:start;vertical-align:top}
.total td{font-weight:700;border-top:2px solid ${colors.green900}}.muted{color:#6b736f;font-size:10pt}.tag{display:inline-block;padding:1px 6px;border:1px solid ${colors.saffronInk};color:${colors.saffronInk};border-radius:4px;font-size:9pt}
pre{white-space:pre-wrap;font-family:inherit}
</style></head><body>${body}</body></html>`;

export function invoiceHtml(inv: { number: string; issued_at: Date; currency: string; lines: any[]; total: number; status: string }, parentName: string, lang: 'ar' | 'en') {
  const ar = lang === 'ar';
  const m = (a: number) => formatMoney({ amount: a, currency: inv.currency as Currency }, lang);
  const rows = inv.lines.map((l) => `<tr><td>${esc(ar ? l.description_ar : l.description_en)} ${l.atCost ? `<span class="tag">${ar ? 'بسعر التكلفة' : 'at cost'}</span>` : ''}</td><td>${m(l.kind === 'refund' ? -l.amount : l.amount)}</td></tr>`).join('');
  return shell(lang, inv.number, `<div class="brand"><h1 style="color:${colors.paper};margin:0">${ar ? 'بر — فاتورة / إيصال' : 'Barr — Invoice / Receipt'}</h1></div>
  <p>${ar ? 'رقم' : 'Number'}: <b>${esc(inv.number)}</b> · ${ar ? 'التاريخ' : 'Date'}: ${inv.issued_at.toISOString().slice(0, 10)} · ${ar ? 'الحالة' : 'Status'}: ${esc(inv.status)}</p>
  <p>${ar ? 'الخدمة لـ' : 'Care for'}: ${esc(parentName)}</p>
  <table><thead><tr><th>${ar ? 'البند' : 'Item'}</th><th>${ar ? 'المبلغ' : 'Amount'}</th></tr></thead><tbody>${rows}<tr class="total"><td>${ar ? 'الإجمالي' : 'Total'}</td><td>${m(inv.total)}</td></tr></tbody></table>
  <p class="muted">${esc(translate(lang, 'plans.notInsurance'))} ${esc(translate(lang, 'plans.prepaid'))}</p>`);
}

/** Simple inline-SVG line chart (no colour-only meaning: values labelled). */
function sparkline(points: { at: string; value: number }[], label: string) {
  if (points.length < 2) return '';
  const w = 480, h = 90, vs = points.map((p) => p.value), min = Math.min(...vs), max = Math.max(...vs), span = max - min || 1;
  const xy = points.map((p, i) => [(i / (points.length - 1)) * (w - 20) + 10, h - 15 - ((p.value - min) / span) * (h - 30)]);
  return `<figure><figcaption><b>${esc(label)}</b> (${min}–${max})</figcaption><svg width="${w}" height="${h}" role="img" aria-label="${esc(label)}">
  <polyline fill="none" stroke="${colors.green900}" stroke-width="2" points="${xy.map((p) => p.join(',')).join(' ')}"/>${xy.map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="3" fill="${colors.saffronInk}"><title>${vs[i]}</title></circle>`).join('')}</svg></figure>`;
}

export function monthlyHtml(r: { payload: MonthlyReportPayload; rendered_ar: string; rendered_en: string }, lang: 'ar' | 'en') {
  const charts = r.payload.vitalsSeries.map((s) => sparkline(s.points, translate(lang, `vitals.${s.kind}`))).join('');
  return shell(lang, 'Monthly report', `<div class="brand"><h1 style="color:${colors.paper};margin:0">${lang === 'ar' ? 'التقرير الشهري' : 'Monthly report'}</h1></div>
  <pre>${esc(lang === 'ar' ? r.rendered_ar : r.rendered_en)}</pre>${charts}`);
}

/** F14: build the monthly report input from the database and store it (idempotent per parent+month). */
/** Signed, expiring link (7 days) so a WhatsApp recipient can open the report without signing in. */
export function reportLink(baseUrl: string, secret: string, reportId: string, now: Date) {
  const exp = Math.floor(now.getTime() / 1000) + 7 * 86_400;
  const sig = createHmac('sha256', secret).update(`report:${reportId}:${exp}`).digest('base64url');
  return `${baseUrl}/v1/r/${reportId}?exp=${exp}&sig=${sig}`;
}
export function verifyReportLink(secret: string, reportId: string, exp: number, sig: string, now: Date) {
  const want = createHmac('sha256', secret).update(`report:${reportId}:${exp}`).digest('base64url');
  return exp * 1000 > now.getTime() && want.length === sig.length && want === sig;
}

export async function generateMonthlyReport(c: Sql, now: Date, parentId: string, month: string, publicBaseUrl: string, linkSecret = '') {
  const exists = (await c.query(`select id from reports where type='monthly' and parent_id=$1 and period_start=$2`, [parentId, `${month}-01`])).rows[0];
  if (exists) return exists.id as string;
  const p = (await c.query(`select id, name, family_id from parents where id=$1`, [parentId])).rows[0];
  if (!p) return null;
  const from = `${month}-01`;
  const [y, m] = month.split('-').map(Number) as [number, number];
  const nextMonth = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  const to = addDays(nextMonth, -1);
  const q = async (sql: string) => (await c.query(sql, [parentId, from, nextMonth])).rows[0];
  const visits = await q(`select count(*) filter (where status <> 'cancelled')::int planned, count(*) filter (where status='completed')::int done from visits where parent_id=$1 and scheduled_at >= $2::date and scheduled_at < $3::date`);
  const doses = await q(`select count(*) filter (where status in ('confirmed','missed'))::int due, count(*) filter (where status='confirmed')::int ok from dose_events where parent_id=$1 and scheduled_at >= $2::date and scheduled_at < $3::date`);
  const esc_ = await q(`select count(*)::int n from escalations where parent_id=$1 and created_at >= $2::date and created_at < $3::date`);
  const con = await q(`select count(*)::int raised, count(*) filter (where status='resolved')::int resolved from concerns where parent_id=$1 and created_at >= $2::date and created_at < $3::date`);
  const carers = await q(`select count(*)::int n from staff_assignments where parent_id=$1 and ended_at >= $2::date and ended_at < $3::date`);
  const vit = (await c.query(`select kind, recorded_at, value from vital_readings where parent_id=$1 and recorded_at >= $2::date and recorded_at < $3::date order by recorded_at`, [parentId, from, nextMonth])).rows;
  const input = {
    parentName: p.name, month, visitsPlanned: visits.planned, visitsCompleted: visits.done,
    vitalsSeries: VITAL_KINDS.map((k) => ({ kind: k, points: vit.filter((v) => v.kind === k).map((v) => ({ at: v.recorded_at.toISOString(), value: Number(v.value) })) })).filter((s) => s.points.length),
    dosesDue: doses.due, dosesConfirmed: doses.ok, escalations: esc_.n, concernsRaised: con.raised, concernsResolved: con.resolved, carerChanges: carers.n,
  };
  const rep = templateMonthlyReportGenerator.generate(parentId, { from, to }, input);
  const r = (await c.query(
    `insert into reports (type, parent_id, period_start, period_end, generator, structured_input, structured_payload, rendered_ar, rendered_en) values ('monthly',$1,$2,$3,$4,$5,$6,$7,$8)
     on conflict do nothing returning id`, [parentId, from, to, rep.generator, input, rep.payload, rep.text_ar, rep.text_en])).rows[0];
  if (!r) return null;
  await notify(c, now, { type: 'monthly_report', parentId, to: { family: p.family_id }, vars: { parent: p.name, month, link: reportLink(publicBaseUrl, linkSecret, r.id, now) }, dedupeKey: `monthly:${r.id}`, data: { reportId: r.id } });
  await audit(c, { actorUserId: null, action: 'report.monthly_generated', entityType: 'report', entityId: r.id, parentId });
  return r.id as string;
}
