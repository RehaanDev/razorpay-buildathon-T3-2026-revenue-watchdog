import { seed } from "../src/seed/generator.js";
import { fitModel } from "../src/pipeline/model.js";
import { runCycle } from "../src/pipeline/cycle.js";

seed();
fitModel();
const s = await runCycle({});
console.log(JSON.stringify(s.leakMap, null, 2));
