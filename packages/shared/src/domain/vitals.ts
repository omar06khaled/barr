import type { BarrConfig } from '../config';

export type VitalKind = 'bp_systolic' | 'bp_diastolic' | 'pulse' | 'glucose' | 'temperature' | 'spo2' | 'weight';

/** Plausible (physically possible to record) range: values outside are rejected as typos. */
export const plausibleRange: Record<VitalKind, [number, number]> = {
  bp_systolic: [50, 260],
  bp_diastolic: [25, 160],
  pulse: [20, 220],
  glucose: [20, 700], // mg/dL
  temperature: [32, 43], // °C
  spo2: [50, 100], // %
  weight: [20, 250], // kg
};

/** Normal range for an older adult: outside → "out of range" flag + coordinator task. */
export const normalRange: Record<VitalKind, [number, number]> = {
  bp_systolic: [90, 150],
  bp_diastolic: [55, 95],
  pulse: [50, 105],
  glucose: [70, 200],
  temperature: [35.5, 37.8],
  spo2: [94, 100],
  weight: [20, 250],
};

export const vitalUnits: Record<VitalKind, string> = {
  bp_systolic: 'mmHg', bp_diastolic: 'mmHg', pulse: 'bpm', glucose: 'mg/dL', temperature: '°C', spo2: '%', weight: 'kg',
};

export interface VitalAssessment {
  kind: VitalKind;
  value: number;
  plausible: boolean;
  outOfRange: boolean;
  critical: boolean;
}

export function assessVital(kind: VitalKind, value: number, critical: BarrConfig['vitalsCritical']): VitalAssessment {
  const [pl, ph] = plausibleRange[kind];
  const [nl, nh] = normalRange[kind];
  const plausible = Number.isFinite(value) && value >= pl && value <= ph;
  const outOfRange = plausible && (value < nl || value > nh);
  let isCritical = false;
  if (plausible) {
    switch (kind) {
      case 'bp_systolic': isCritical = value >= critical.systolicHigh || value <= critical.systolicLow; break;
      case 'bp_diastolic': isCritical = value >= critical.diastolicHigh; break;
      case 'pulse': isCritical = value >= critical.pulseHigh || value <= critical.pulseLow; break;
      case 'glucose': isCritical = value >= critical.glucoseHigh || value <= critical.glucoseLow; break;
      case 'temperature': isCritical = value >= critical.tempHigh; break;
      case 'spo2': isCritical = value <= critical.spo2Low; break;
      case 'weight': isCritical = false; break;
    }
  }
  return { kind, value, plausible, outOfRange, critical: isCritical };
}
