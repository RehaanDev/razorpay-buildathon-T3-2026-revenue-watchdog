import { seed } from '../src/seed/generator.js';
import { fitModel } from '../src/pipeline/model.js';
import { runCycle } from '../src/pipeline/cycle.js';
import { settleSimulatedPending } from '../src/pipeline/execute.js';
import { store } from '../src/store.js';
import { twoProportionTest } from '../src/lib/stats.js';
import { rupees } from '../src/lib/util.js';

/**
 * Multi-day accumulation.
 *
 * A single day of one merchant's traffic produces something like thirty
 * treatment decisions and eight control decisions. At those sizes the measured
 * lift is noise: it comes out positive or negative depending on the seed, and
 * either way it means nothing. The interface says so, which is correct, but
 * "correct and uninformative" is a bad place to leave the headline number.
 *
 * So this runs the same pipeline over many independent days and pools the arms.
 * Nothing about the decision logic changes; only the sample size does. The point
 * is to show what the measurement machinery says once it has enough data to say
 * anything, and to be explicit that one day never did.
 *
 *   node scripts/accumulate.js 40
 */

const days = Number(process.argv[2] || 30);

const pooled = {
  control: { n: 0, recovered: 0, amount: 0, exposed: 0 },
  treatment: { n: 0, recovered: 0, amount: 0, exposed: 0 },
};
const perDay = [];
let pendingSettled = 0;

console.log(`\nAccumulating ${days} independent days\n`);
console.log('  day   control            treatment          daily lift');
console.log('  ' + '-'.repeat(62));

for (let d = 0; d < days; d++) {
  // Each day is a fresh world. Re-seeding with a different RNG stream is what
  // makes the days independent; pooling correlated days would inflate
  // significance without adding information.
  process.env.RW_DAY_SEED = String(d);
  seed();
  fitModel();
  await runCycle({});

  // Resolve the shopper-dependent actions before measuring. Without this the
  // treatment arm is scored with its best action still in flight: every emailed
  // link sits in the denominator as an unresolved failure while the control
  // arm's naive retries have all settled. That comparison is not a lift, it is
  // an artefact of one arm being allowed to finish and the other not.
  const settled = settleSimulatedPending();
  pendingSettled += settled;

  const stillPending = store.actions.filter((a) => a.pending).length;
  if (stillPending) throw new Error(`${stillPending} actions unsettled on day ${d + 1}; the arms are not comparable`);

  const arms = {
    control: store.actions.filter((a) => a.arm === 'control'),
    treatment: store.actions.filter((a) => a.arm === 'treatment'),
  };

  for (const key of ['control', 'treatment']) {
    pooled[key].n += arms[key].length;
    pooled[key].recovered += arms[key].filter((a) => a.recovered).length;
    pooled[key].amount += arms[key].reduce((s, a) => s + a.recoveredAmount, 0);
    pooled[key].exposed += arms[key].reduce((s, a) => s + a.amount, 0);
  }

  const cr = arms.control.length ? arms.control.filter((a) => a.recovered).length / arms.control.length : 0;
  const tr = arms.treatment.length ? arms.treatment.filter((a) => a.recovered).length / arms.treatment.length : 0;
  perDay.push({ day: d + 1, controlN: arms.control.length, treatmentN: arms.treatment.length, lift: tr - cr });

  if (d < 10 || d === days - 1) {
    console.log(
      `  ${String(d + 1).padStart(3)}   ${String(arms.control.length).padStart(3)} @ ${(cr * 100).toFixed(0).padStart(3)}%` +
        `        ${String(arms.treatment.length).padStart(3)} @ ${(tr * 100).toFixed(0).padStart(3)}%` +
        `        ${(tr - cr >= 0 ? '+' : '') + ((tr - cr) * 100).toFixed(1)}pp`
    );
  } else if (d === 10) {
    console.log('   ...');
  }
}

const cRate = pooled.control.recovered / pooled.control.n;
const tRate = pooled.treatment.recovered / pooled.treatment.n;
const test = twoProportionTest(pooled.control.recovered, pooled.control.n, pooled.treatment.recovered, pooled.treatment.n);
const counterfactual = Math.round(pooled.treatment.exposed * (pooled.control.amount / (pooled.control.exposed || 1)));

const positiveDays = perDay.filter((d) => d.lift > 0).length;
const negativeDays = perDay.filter((d) => d.lift < 0).length;

console.log('\nPooled result');
console.log(`  control     ${pooled.control.n} decisions, ${pooled.control.recovered} recovered (${(cRate * 100).toFixed(1)}%)`);
console.log(`  treatment   ${pooled.treatment.n} decisions, ${pooled.treatment.recovered} recovered (${(tRate * 100).toFixed(1)}%)`);
console.log(`  absolute lift   ${(tRate - cRate >= 0 ? '+' : '') + ((tRate - cRate) * 100).toFixed(2)}pp`);
console.log(`  relative lift   ${(((tRate - cRate) / cRate) * 100).toFixed(1)}%`);
console.log(`  p-value         ${test.pValue.toFixed(4)} ${test.significant ? '(significant at 5%)' : '(NOT significant at 5%)'}`);
console.log(`  incremental     ${rupees(pooled.treatment.amount - counterfactual)} over what the naive arm's rate would have produced`);

console.log(`  links settled   ${pendingSettled} shopper-dependent actions resolved before measuring`);

console.log('\nWhy one day was never enough');
console.log(`  ${positiveDays} of ${days} days showed positive lift, ${negativeDays} showed negative.`);
console.log('  Same system, same logic, opposite headline. Any single day of this data can be');
console.log('  made to say whatever you want it to say, which is exactly why the product refuses');
console.log('  to print a lift figure until the arms are large enough to support one.\n');

if (!test.significant) {
  console.log('  Still not significant at this sample size. That is a real answer, not a failure:');
  console.log('  the honest report is the confidence interval and the sample size required, not a');
  console.log('  number dressed up as a result.\n');
}
