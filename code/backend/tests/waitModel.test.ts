import {
  FEATURE_NAMES,
  MAX_SERVICE_MINUTES,
  MIN_SERVICE_MINUTES,
  PrintItem,
  Sample,
  featuresFromItems,
  fitModel,
  isOverrunning,
  OVERRUN_GRACE_MINUTES,
  predictServiceMinutes,
  predictWait,
} from '../src/services/waitModel';

// Deterministic pseudo-random numbers so the tests never flake.
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}
function gaussian(random: () => number): number {
  return Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random());
}

// A shop whose real printer speeds differ from the textbook defaults.
const TRUE = { perJob: 0.8, bw: 0.09, colour: 0.22, binding: 5, lamStaple: 2.5, noise: 0.4 };

function syntheticOrders(count: number, seed: number): Sample[] {
  const random = rng(seed);
  return Array.from({ length: count }, () => {
    const items: PrintItem[] = [
      {
        pages: 1 + Math.floor(random() * 80),
        copies: 1 + Math.floor(random() * 2),
        printType: random() < 0.3 ? 'COLOR' : 'BW',
        finishing: random() < 0.25 ? 'SPIRAL_BINDING' : random() < 0.15 ? 'LAMINATION' : 'NONE',
      },
    ];
    const x = featuresFromItems(items);
    const y =
      TRUE.perJob + TRUE.bw * x[1]! + TRUE.colour * x[2]! + TRUE.binding * x[3]! + TRUE.lamStaple * x[4]! + gaussian(random) * TRUE.noise;
    return { x, y };
  });
}

describe('featuresFromItems', () => {
  it('turns an order into page-sides by type plus finishing counts', () => {
    const x = featuresFromItems([
      { pages: 10, copies: 2, printType: 'BW', finishing: 'SPIRAL_BINDING' },
      { pages: 5, copies: 1, printType: 'COLOR', finishing: 'LAMINATION' },
      { pages: 3, copies: 1, printType: 'BW', finishing: null },
    ]);
    expect(FEATURE_NAMES).toHaveLength(x.length);
    expect(x).toEqual([1, 10 * 2 + 3, 5, 1, 1]);
  });

  it('treats zero copies as one and never goes negative', () => {
    expect(featuresFromItems([{ pages: 4, copies: 0, printType: 'BW', finishing: 'NONE' }])).toEqual([1, 4, 0, 0, 0]);
    expect(featuresFromItems([{ pages: -5, copies: 1, printType: 'BW', finishing: 'NONE' }])).toEqual([1, 0, 0, 0, 0]);
  });
});

describe('fitModel - starts sensible with no data', () => {
  const empty = fitModel([]);

  it('uses typical printer speeds and says it has learned nothing yet', () => {
    expect(empty.trainingOrders).toBe(0);
    expect(empty.maeMinutes).toBeNull();
    expect(empty.baselineMaeMinutes).toBeNull();
    const small = predictServiceMinutes(empty.weights, featuresFromItems([{ pages: 5, copies: 1, printType: 'BW', finishing: 'NONE' }]));
    const big = predictServiceMinutes(empty.weights, featuresFromItems([{ pages: 200, copies: 1, printType: 'COLOR', finishing: 'SPIRAL_BINDING' }]));
    expect(small).toBeLessThan(3);
    expect(big).toBeGreaterThan(15);
    expect(big).toBeGreaterThan(small * 5); // a big colour thesis is far slower than a short B&W job
  });
});

describe('fitModel - learns a shop from its history', () => {
  it('recovers the shop’s real speeds from completed orders', () => {
    const model = fitModel(syntheticOrders(80, 7));
    expect(model.trainingOrders).toBe(80);
    const [perJob, bw, colour, binding, lamStaple] = model.weights;
    expect(perJob).toBeCloseTo(TRUE.perJob, 0);
    expect(bw).toBeCloseTo(TRUE.bw, 2);
    expect(colour).toBeCloseTo(TRUE.colour, 1);
    expect(Math.abs(binding! - TRUE.binding)).toBeLessThan(1);
    expect(Math.abs(lamStaple! - TRUE.lamStaple)).toBeLessThan(1);
  });

  it('beats "always predict the average" on orders it has never seen (leave-one-out)', () => {
    const model = fitModel(syntheticOrders(80, 11));
    expect(model.maeMinutes).not.toBeNull();
    expect(model.baselineMaeMinutes).not.toBeNull();
    // The point of using a model at all: much smaller errors than the average.
    expect(model.maeMinutes!).toBeLessThan(model.baselineMaeMinutes! * 0.35);
    expect(model.maeMinutes!).toBeLessThan(1);
  });

  it('predicts held-out jobs close to their true time', () => {
    const model = fitModel(syntheticOrders(80, 21));
    const test = syntheticOrders(40, 99);
    const mae = test.reduce((s, t) => s + Math.abs(t.y - predictServiceMinutes(model.weights, t.x)), 0) / test.length;
    expect(mae).toBeLessThan(0.8);
  });

  it('gets more certain as it sees more orders', () => {
    const few = fitModel(syntheticOrders(6, 3));
    const many = fitModel(syntheticOrders(120, 3));
    const job = featuresFromItems([{ pages: 60, copies: 1, printType: 'BW', finishing: 'NONE' }]);
    const spread = (m: typeof few) => {
      const p = predictWait(m, [job, job, job], null);
      return p.high - p.low;
    };
    expect(spread(many)).toBeLessThan(spread(few));
  });

  it('drops abandoned orders completely - they have zero influence, even in a small history', () => {
    // An order left in PRINTING for weeks "took" 52,156 minutes. That is an
    // abandoned order, not a print time: it must not be learned from at all
    // (clamping it to a 2-hour job would still teach a false speed).
    const job = featuresFromItems([{ pages: 40, copies: 1, printType: 'BW', finishing: 'NONE' }]);
    for (const size of [14, 60]) {
      const clean = syntheticOrders(size, 5);
      const abandoned: Sample[] = [
        ...clean,
        { x: featuresFromItems([{ pages: 2, copies: 1, printType: 'BW', finishing: 'NONE' }]), y: 52156 },
        { x: job, y: 900 },
      ];
      const a = fitModel(clean);
      const b = fitModel(abandoned);
      expect(b.trainingOrders).toBe(a.trainingOrders);
      expect(b.weights).toEqual(a.weights);
    }
  });

  it('ignores invalid rows and never learns a negative speed', () => {
    const x = featuresFromItems([{ pages: 10, copies: 1, printType: 'BW', finishing: 'NONE' }]);
    const model = fitModel([
      { x, y: Number.NaN },
      { x, y: -4 },
      { x, y: 0.25 },
    ]);
    expect(model.trainingOrders).toBe(1);
    expect(model.weights.every((w) => w >= 0)).toBe(true);
  });

  it('keeps predictions inside sane bounds', () => {
    const model = fitModel([]);
    expect(predictServiceMinutes(model.weights, [1, 0, 0, 0, 0])).toBeGreaterThanOrEqual(MIN_SERVICE_MINUTES);
    expect(predictServiceMinutes(model.weights, [1, 1e7, 1e7, 50, 50])).toBe(MAX_SERVICE_MINUTES);
  });
});

describe('predictWait', () => {
  const model = fitModel(syntheticOrders(60, 13));
  const small = featuresFromItems([{ pages: 5, copies: 1, printType: 'BW', finishing: 'NONE' }]);
  const big = featuresFromItems([{ pages: 150, copies: 2, printType: 'COLOR', finishing: 'SPIRAL_BINDING' }]);

  it('is zero when nobody is ahead and nothing is printing', () => {
    expect(predictWait(model, [], null)).toEqual({ minutes: 0, low: 0, high: 0 });
  });

  it('depends on WHAT is ahead, not just how many - the reason to use a model', () => {
    const behindSmall = predictWait(model, [small, small], null);
    const behindBig = predictWait(model, [big, big], null);
    expect(behindBig.minutes).toBeGreaterThan(behindSmall.minutes * 10);
  });

  it('grows as more orders queue up', () => {
    const one = predictWait(model, [small], null).minutes;
    const five = predictWait(model, [small, small, small, small, small], null).minutes;
    expect(five).toBeGreaterThan(one);
  });

  it('counts only what is LEFT of the order that is printing now', () => {
    const justStarted = predictWait(model, [small], { x: big, elapsedMinutes: 0 });
    const nearlyDone = predictWait(model, [small], { x: big, elapsedMinutes: 1000 });
    expect(justStarted.minutes).toBeGreaterThan(nearlyDone.minutes + 5);
    expect(nearlyDone.minutes).toBeGreaterThanOrEqual(1); // never claims "0" while a job is still printing
  });

  it('returns an ordered range that contains the estimate', () => {
    const p = predictWait(model, [small, big, small], { x: small, elapsedMinutes: 0.5 });
    expect(p.low).toBeLessThanOrEqual(p.minutes);
    expect(p.high).toBeGreaterThanOrEqual(p.minutes);
    expect(p.low).toBeGreaterThanOrEqual(0);
  });

  it('is honest that an untrained model is less sure than a trained one', () => {
    const untrained = fitModel([]);
    const trained = fitModel(syntheticOrders(120, 17));
    const queue = [big, small, big];
    const spread = (m: typeof untrained) => {
      const p = predictWait(m, queue, null);
      return (p.high - p.low) / Math.max(1, p.minutes);
    };
    expect(spread(trained)).toBeLessThan(spread(untrained));
  });
});

describe('isOverrunning - noticing a jam instead of showing a false estimate', () => {
  const model = fitModel(syntheticOrders(60, 29));
  const job = featuresFromItems([{ pages: 40, copies: 1, printType: 'BW', finishing: 'NONE' }]);
  const expected = predictServiceMinutes(model.weights, job);

  it('is not triggered by a normal print, even a slowish one', () => {
    expect(isOverrunning(model, job, 0)).toBe(false);
    expect(isOverrunning(model, job, expected)).toBe(false);
    expect(isOverrunning(model, job, expected * 1.5)).toBe(false);
  });

  it('is triggered when the order runs far past its own predicted time', () => {
    expect(isOverrunning(model, job, expected + 30)).toBe(true);
    expect(isOverrunning(model, job, 600)).toBe(true); // forgotten overnight
  });

  it('always allows a small grace on top of the range', () => {
    expect(OVERRUN_GRACE_MINUTES).toBeGreaterThan(0);
    expect(isOverrunning(model, job, expected + OVERRUN_GRACE_MINUTES * 0.5)).toBe(false);
  });

  it('allows a bigger safety margin for a shop it knows little about', () => {
    // How far past its own expected time an order must run before it is called
    // an overrun. A model that has learned less is less sure what "normal" is,
    // so it should wait longer before crying "delayed".
    const margin = (m: typeof model) => {
      const expectedMinutes = predictServiceMinutes(m.weights, job);
      let elapsed = expectedMinutes;
      while (!isOverrunning(m, job, elapsed) && elapsed < expectedMinutes + 500) elapsed += 0.05;
      return elapsed - expectedMinutes;
    };
    expect(margin(fitModel([]))).toBeGreaterThan(margin(model));
  });
});
