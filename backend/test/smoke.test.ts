import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, makeHarness, newFamily, type Harness } from './harness';

let h: Harness;
beforeAll(async () => { h = await makeHarness(); });
afterAll(async () => { await h.close(); });

describe('smoke', () => {
  it('health + family can create a parent and read it back decrypted', async () => {
    const f = await newFamily(h);
    const p = await api(h, f.token, 'GET', `/parents/${f.parentId}`);
    expect(p.status).toBe(200);
    expect(p.body.address).toContain('Zamalek');
    expect(p.body.carerPreference).toBe('female');
    const raw = (await h.owner.query(`select address_enc, phone_enc from parents where id=$1`, [f.parentId])).rows[0];
    expect(raw.address_enc.startsWith('v1.')).toBe(true);
    expect(raw.address_enc).not.toContain('Zamalek');
  });
});
