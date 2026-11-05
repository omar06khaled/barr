import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

/** Countries we expect: Gulf (families) + Egypt (parents/staff). Others accepted if valid with +. */
export const SUPPORTED_COUNTRIES: CountryCode[] = ['EG', 'SA', 'KW', 'AE', 'QA', 'BH', 'OM'];

/** Normalise to E.164 or return null. `defaultCountry` used when no + prefix. */
export function toE164(input: string, defaultCountry: CountryCode = 'EG'): string | null {
  const cleaned = input.replace(/[\s\-()]/g, '').replace(/^00/, '+');
  const parsed = parsePhoneNumberFromString(cleaned, defaultCountry);
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number;
}

export function maskPhone(e164: string): string {
  return e164.length > 6 ? `${e164.slice(0, 4)}••••${e164.slice(-2)}` : '••••';
}
