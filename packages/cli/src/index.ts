export { run, type RunIO } from "./main.js";
export { buildRunContext, toRunOptions, exitCodeFor, UsageError, type GlobalOpts, type IO, type RunContext } from "./context.js";
export { renderPlan, renderApply, planJson, applyJson, planSummary, finalLine, sideText, diffText, type RenderOptions } from "./render.js";
export { errorEnvelope, serialize, toSponsonError, STRUCTURAL_KEYS, type ErrorEnvelope } from "./output.js";
export { executePlan, type PlanOutcome } from "./commands/plan.js";
export { executeApply, type ApplyOpts, type ApplyOutcome } from "./commands/apply.js";
export { adoptChanges, appendChanges, type InitOpts, type Adoption } from "./commands/init.js";
