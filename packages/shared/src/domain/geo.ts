export interface GeoPoint { lat: number; lng: number }

/** Haversine distance in metres. */
export function distanceM(a: GeoPoint, b: GeoPoint): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type CheckInDecision =
  | { allowed: true; distanceM: number; overridden: boolean }
  | { allowed: false; distanceM: number; reason: 'outside_radius' | 'no_location' };

/** F5: staff may start a visit only within the CONFIG radius, unless an admin override with reason exists. */
export function checkInDecision(args: {
  staff: GeoPoint | null;
  home: GeoPoint;
  radiusM: number;
  adminOverrideReason?: string | null;
}): CheckInDecision {
  if (args.adminOverrideReason && args.adminOverrideReason.trim().length > 0) {
    return { allowed: true, distanceM: args.staff ? distanceM(args.staff, args.home) : -1, overridden: true };
  }
  if (!args.staff) return { allowed: false, distanceM: -1, reason: 'no_location' };
  const d = distanceM(args.staff, args.home);
  return d <= args.radiusM ? { allowed: true, distanceM: d, overridden: false } : { allowed: false, distanceM: d, reason: 'outside_radius' };
}
