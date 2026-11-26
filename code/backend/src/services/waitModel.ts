// Print-time prediction: Bayesian linear regression.
//
// The time a job takes to print is modelled as a weighted sum of what the
// job contains:
//
//   minutes = w0*1 + w1*(B&W page-sides) + w2*(colour page-sides)
//                  + w3*(binding jobs)   + w4*(lamination/stapling jobs)
//
// The weights are the shop's own "printer speed": setup time per job,
// minutes per B&W page, minutes per colour page and so on. They are LEARNED
// from the shop's completed orders. Each weight starts from a prior (a
// typical office-printer speed) with an uncertainty, and is updated by the
// data - so the model gives sensible answers with no history at all and
// gets sharper as the shop completes orders. Because it is Bayesian, every
// prediction also comes with a variance, which becomes the "likely range".
//
// A student's wait is the sum of the predicted print times of the orders
// ahead of them plus whatever is left of the order printing right now.
//
// Pure TypeScript, no database and no external ML library, so it is
// unit-testable and easy to explain:
//   posterior  w ~ N(m, S),  S = (XᵀX/σ² + P)⁻¹,  m = S (Xᵀy/σ² + P w0)
// where P = diag(1/priorSd²) is the prior precision and σ the noise level.

export const FEATURE_NAMES = [
  'perJob', // fixed set-up / hand-over time per order
  'perBlackWhitePage',
  'perColourPage',
  'perBinding', // spiral or hard binding
  'perLaminationOrStaple',
] as const;
const P = FEATURE_NAMES.length;

// Typical office-printer behaviour, in minutes, and how unsure we are.
const PRIOR_MEAN = [1.0, 0.04, 0.1, 3.0, 1.5];
// Deliberately wide (~100% of the mean): every shop's printers differ, so before
// it has any history the model must say "I'm not sure" and show a wide range.
const PRIOR_SD = [1.0, 0.04, 0.1, 3.0, 1.5];

const DEFAULT_NOISE_SD = 1.2; // minutes, before any data
const MIN_NOISE_SD = 0.3;
const NOISE_PSEUDO_OBSERVATIONS = 3; // shrinks the noise estimate toward the default
export const MIN_SERVICE_MINUTES = 0.25;
export const MAX_SERVICE_MINUTES = 120; // a real large colour+binding job can take this long; hours means a forgotten order
const MIN_REMAINING_MINUTES = 0.5;
const Z_80 = 1.2816; // two-sided 80% interval
const MIN_SAMPLES_FOR_EVALUATION = 5;

export interface PrintItem {
  pages: number;
  copies: number;
  printType: 'BW' | 'COLOR';
  finishing: 'SPIRAL_BINDING' | 'HARD_BINDING' | 'STAPLING' | 'LAMINATION' | 'NONE' | null;
}

// One order -> its feature vector (order-level: items add up).
export function featuresFromItems(items: PrintItem[]): number[] {
  const x = [1, 0, 0, 0, 0];
  for (const item of items) {
    const impressions = Math.max(0, item.pages) * Math.max(1, item.copies);
    if (item.printType === 'COLOR') x[2]! += impressions;
    else x[1]! += impressions;
    if (item.finishing === 'SPIRAL_BINDING' || item.finishing === 'HARD_BINDING') x[3]! += 1;
    else if (item.finishing === 'LAMINATION' || item.finishing === 'STAPLING') x[4]! += 1;
  }
  return x;
}

export interface Sample {
  x: number[];
  // Observed print time in minutes.
  y: number;
}

export interface WaitModel {
  weights: number[];
  // Posterior covariance of the weights (P x P).
  covariance: number[][];
  noiseSd: number;
  trainingOrders: number;
  // Leave-one-out mean absolute error of this model vs. always predicting
  // the average print time. null until there are enough orders to test on.
  maeMinutes: number | null;
  baselineMaeMinutes: number | null;
}

// ── tiny linear algebra (5x5) ────────────────────────────────────────────

function invert(matrix: number[][]): number[][] {
  const n = matrix.length;
  const a = matrix.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(a[r]![col]!) > Math.abs(a[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(a[pivot]![col]!) < 1e-12) throw new Error('singular matrix');
    [a[col], a[pivot]] = [a[pivot]!, a[col]!];
    const div = a[col]![col]!;
    for (let c = 0; c < 2 * n; c += 1) a[col]![c]! /= div;
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const factor = a[r]![col]!;
      if (factor === 0) continue;
      for (let c = 0; c < 2 * n; c += 1) a[r]![c]! -= factor * a[col]![c]!;
    }
  }
  return a.map((row) => row.slice(n));
}

const dot = (u: number[], v: number[]): number => u.reduce((sum, ui, i) => sum + ui * v[i]!, 0);
const matVec = (m: number[][], v: number[]): number[] => m.map((row) => dot(row, v));

// ── fitting ──────────────────────────────────────────────────────────────

function posterior(samples: Sample[], noiseSd: number): { weights: number[]; covariance: number[][] } {
  const variance = noiseSd * noiseSd;
  const a: number[][] = Array.from({ length: P }, (_, i) =>
    Array.from({ length: P }, (_, j) => (i === j ? 1 / (PRIOR_SD[i]! * PRIOR_SD[i]!) : 0)),
  );
  const b = PRIOR_MEAN.map((m, i) => m / (PRIOR_SD[i]! * PRIOR_SD[i]!));
  for (const { x, y } of samples) {
    for (let i = 0; i < P; i += 1) {
      b[i]! += (x[i]! * y) / variance;
      for (let j = 0; j < P; j += 1) a[i]![j]! += (x[i]! * x[j]!) / variance;
    }
  }
  const covariance = invert(a);
  // Print speeds cannot be negative.
  const weights = matVec(covariance, b).map((w) => Math.max(0, w));
  return { weights, covariance };
}

function fitCore(samples: Sample[]): { weights: number[]; covariance: number[][]; noiseSd: number } {
  let noiseSd = DEFAULT_NOISE_SD;
  let fit = posterior(samples, noiseSd);
  if (samples.length > 0) {
    // One refinement: estimate the noise level from how far the first fit
    // is from the data, then refit with it.
    const sumSq = samples.reduce((s, { x, y }) => s + (y - dot(fit.weights, x)) ** 2, 0);
    noiseSd = Math.max(
      MIN_NOISE_SD,
      Math.sqrt((sumSq + NOISE_PSEUDO_OBSERVATIONS * DEFAULT_NOISE_SD ** 2) / (samples.length + NOISE_PSEUDO_OBSERVATIONS)),
    );
    fit = posterior(samples, noiseSd);
  }
  return { ...fit, noiseSd };
}

export function predictServiceMinutes(weights: number[], x: number[]): number {
  return Math.min(MAX_SERVICE_MINUTES, Math.max(MIN_SERVICE_MINUTES, dot(weights, x)));
}

export function fitModel(rawSamples: Sample[]): WaitModel {
  // An order left in PRINTING overnight (or completed instantly by mistake)
  // must not teach the model nonsense.
  // Orders that "took" longer than any real job (left in PRINTING overnight,
  // or for weeks) are abandoned orders, not print times: they are DROPPED, not
  // clamped - clamping would still teach the model a false 2-hour job. Very
  // fast ones (clicked Start/Complete instantly) are raised to a small floor.
  const samples = rawSamples
    .filter((s) => Number.isFinite(s.y) && s.y >= 0 && s.y <= MAX_SERVICE_MINUTES)
    .map((s) => ({ x: s.x, y: Math.max(MIN_SERVICE_MINUTES, s.y) }));

  const core = fitCore(samples);

  let maeMinutes: number | null = null;
  let baselineMaeMinutes: number | null = null;
  if (samples.length >= MIN_SAMPLES_FOR_EVALUATION) {
    // Leave-one-out: predict each order from a model that never saw it.
    let modelErr = 0;
    let baseErr = 0;
    const total = samples.reduce((s, r) => s + r.y, 0);
    samples.forEach((held, i) => {
      const rest = samples.filter((_, j) => j !== i);
      const fit = fitCore(rest);
      modelErr += Math.abs(held.y - predictServiceMinutes(fit.weights, held.x));
      baseErr += Math.abs(held.y - (total - held.y) / rest.length);
    });
    maeMinutes = round2(modelErr / samples.length);
    baselineMaeMinutes = round2(baseErr / samples.length);
  }

  return { ...core, trainingOrders: samples.length, maeMinutes, baselineMaeMinutes };
}

// ── noticing that something is wrong ─────────────────────────────────────

// An order that has been printing far longer than its own predicted range
// (a jam, paper out, a stuck job) must not keep producing "about a minute
// left". Beyond the 80% upper bound plus a small grace, call it an overrun.
export const OVERRUN_GRACE_MINUTES = 2;

export function isOverrunning(model: WaitModel, x: number[], elapsedMinutes: number): boolean {
  const mean = predictServiceMinutes(model.weights, x);
  const sd = Math.sqrt(model.noiseSd ** 2 + Math.max(0, dot(x, matVec(model.covariance, x))));
  return elapsedMinutes > mean + Z_80 * sd + OVERRUN_GRACE_MINUTES;
}

// ── predicting a student's wait ──────────────────────────────────────────

export interface WaitPrediction {
  minutes: number;
  low: number;
  high: number;
}

// `ahead`: feature vectors of the WAITING orders in front of this one.
// `printing`: the order being printed now, with minutes already spent on it.
export function predictWait(
  model: WaitModel,
  ahead: number[][],
  printing: { x: number[]; elapsedMinutes: number } | null,
): WaitPrediction {
  let mean = 0;
  let orders = ahead.length;
  const summed = new Array<number>(P).fill(0);

  for (const x of ahead) {
    mean += predictServiceMinutes(model.weights, x);
    for (let i = 0; i < P; i += 1) summed[i]! += x[i]!;
  }
  if (printing) {
    const full = predictServiceMinutes(model.weights, printing.x);
    mean += Math.max(MIN_REMAINING_MINUTES, full - Math.max(0, printing.elapsedMinutes));
    for (let i = 0; i < P; i += 1) summed[i]! += printing.x[i]!;
    orders += 1;
  }

  // Uncertainty: each order's own noise adds up, plus the (shared) doubt
  // about the weights themselves.
  const weightVariance = Math.max(0, dot(summed, matVec(model.covariance, summed)));
  const sd = Math.sqrt(orders * model.noiseSd ** 2 + weightVariance);
  return {
    minutes: Math.ceil(mean),
    low: Math.max(0, Math.floor(mean - Z_80 * sd)),
    high: Math.ceil(mean + Z_80 * sd),
  };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
