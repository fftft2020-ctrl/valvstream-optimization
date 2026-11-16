// Offline screening only. Equations: Masoneilan sizing handbook pp. 5, 13–14.
export class PreSizingError extends Error {}

function finite(value, label, { min = -Infinity, max = Infinity, exclusive = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || (exclusive ? value <= min : value < min) || value > max) {
    throw new PreSizingError(`${label}: expected finite number ${exclusive ? ">" : ">="} ${min}, <= ${max}`);
  }
  return value;
}
const positive = (v, k) => finite(v, k, { min: 0, exclusive: true });
function text(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new PreSizingError(`${label}: nonempty text required`);
  return value;
}

export function pressureBarAbsolute(value, unit, atmosphereBar) {
  finite(value, "pressure");
  const m = /^(bar|kPa|MPa|psi) ([ag])$/.exec(unit);
  if (!m) throw new PreSizingError(`unsupported/ambiguous pressure unit: ${unit}; use e.g. bar a or bar g`);
  const scale = { bar: 1, kPa: .01, MPa: 10, psi: .06894757293168 }[m[1]];
  const p = value * scale + (m[2] === "g" ? positive(atmosphereBar, "atmosphereBar") : 0);
  return positive(p, "absolute pressure");
}

export function kelvin(value, unit) {
  finite(value, "temperature");
  const k = unit === "deg C" ? value + 273.15 : unit === "deg F" ? (value - 32) * 5 / 9 + 273.15 : unit === "K" ? value : NaN;
  return positive(k, "temperature (supported units: deg C, deg F, K)");
}

function factor(config, name, { max = 1 } = {}) {
  const supplied = config?.[name];
  if (!supplied) return null;
  text(supplied.basis, `${name}.basis`);
  const range = supplied.values ?? [supplied.value];
  if (!Array.isArray(range) || !range.length || range.length > 8) throw new PreSizingError(`${name}: 1–8 explicit sensitivity values required`);
  return [...new Set(range.map(v => finite(v, name, { min: 0, max, exclusive: true })))];
}

export function normalizePreSizingInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new PreSizingError("input must be an object");
  const { sizing, preSizing: options } = input;
  if (!sizing || !options) throw new PreSizingError("sizing and preSizing are required");
  if (!["liquid", "gas"].includes(options.phase)) throw new PreSizingError("only single-phase liquid/gas are supported");
  if (options.singlePhase !== true || options.turbulent !== true) throw new PreSizingError("explicit singlePhase=true and turbulent=true assessments required; no viscosity/two-phase correction");
  text(options.assessmentBasis, "preSizing.assessmentBasis");
  const fp = factor(options.factors, "fp");
  if (!fp) throw new PreSizingError("explicit fp value and basis required; pipe reducer correction is not inferred");
  const fl = factor(options.factors, "fl");
  const xt = factor(options.factors, "xt");
  if (fp.some(v => v !== 1)) throw new PreSizingError("attached fittings/reducers require FLP/xTP coupling; current engine requires explicitly justified fp=1");
  if (!Array.isArray(sizing.cases) || !sizing.cases.length) throw new PreSizingError("at least one flow case required");
  const names = new Set();
  const cases = sizing.cases.map((c, i) => {
    text(c.name, `case ${i}.name`);
    if (names.has(c.name)) throw new PreSizingError(`duplicate case name: ${c.name}`);
    names.add(c.name);
    const p1 = pressureBarAbsolute(c.p1, sizing.pressureUnit, options.atmosphereBar);
    const p2 = pressureBarAbsolute(c.p2, sizing.pressureUnit, options.atmosphereBar);
    if (p1 <= p2) throw new PreSizingError(`${c.name}: forward flow requires p1 > p2`);
    const temperatureK = kelvin(c.temperature, sizing.temperatureUnit);
    const flow = finite(c.flow, `${c.name}.flow`, { min: 0 });
    const properties = c.properties;
    if (!properties || typeof properties !== "object") throw new PreSizingError(`${c.name}.properties required at inlet flowing conditions`);
    text(properties.basis, `${c.name}.properties.basis`);
    const density = positive(properties.densityKgM3, `${c.name}.densityKgM3`);
    let massFlowKgH;
    switch (sizing.flowUnit) {
      case "kg/h": massFlowKgH = flow; break;
      case "t/h": massFlowKgH = flow * 1000; break;
      case "m3/h": massFlowKgH = flow * density; break;
      case "L/h": massFlowKgH = flow / 1000 * density; break;
      case "USgpm": massFlowKgH = flow * .22712470704 * density; break;
      case "Nm3/h":
      case "Sm3/h":
        if (options.phase !== "gas") throw new PreSizingError("standard volume requires gas");
        // A named standard-volume unit alone does not define its reference state.
        text(properties.baseDensityBasis, `${c.name}.baseDensityBasis`);
        positive(properties.basePressureBarA, `${c.name}.basePressureBarA`);
        positive(properties.baseTemperatureK, `${c.name}.baseTemperatureK`);
        massFlowKgH = flow * positive(properties.baseDensityKgM3, `${c.name}.baseDensityKgM3`);
        break;
      default: throw new PreSizingError(`unsupported flow unit: ${sizing.flowUnit}`);
    }
    positiveOrZero(massFlowKgH, "massFlowKgH");
    const normalized = { name: c.name, p1, p2, temperatureK, density, massFlowKgH };
    if (options.phase === "gas") normalized.k = finite(properties.k, `${c.name}.k`, { min: 1, exclusive: true });
    else {
      normalized.pv = finite(properties.vaporPressureBarA, `${c.name}.vaporPressureBarA`, { min: 0 });
      normalized.pc = positive(properties.criticalPressureBarA, `${c.name}.criticalPressureBarA`);
      if (normalized.pv >= normalized.pc || p1 <= normalized.pv) throw new PreSizingError(`${c.name}: not a supported subcritical inlet liquid`);
    }
    return normalized;
  });
  const window = options.preferredTravelPercent;
  if (window !== undefined) {
    if (!Array.isArray(window) || window.length !== 2) throw new PreSizingError("preferredTravelPercent must be [min,max]");
    finite(window[0], "minimum travel", { min: 0, max: 100 });
    finite(window[1], "maximum travel", { min: 0, max: 100 });
    if (window[0] >= window[1]) throw new PreSizingError("travel window must increase");
    text(options.travelWindowBasis, "travelWindowBasis");
  }
  return { phase: options.phase, cases, fp, fl, xt, preferredTravelPercent: window ?? null,
    assumptions: { assessmentBasis: options.assessmentBasis, factors: options.factors,
      travelWindowBasis: options.travelWindowBasis ?? null },
    candidateFilter: options.candidateFilter ?? {}, curveIds: options.curveIds ?? null };
}

function positiveOrZero(v, label) { return finite(v, label, { min: 0 }); }

export function requiredCv(c, phase, factors) {
  // Normalize before calling; the exported function also rejects invalid coefficients.
  positive(c.p1, "p1"); positive(c.p2, "p2"); positive(c.density, "density");
  positiveOrZero(c.massFlowKgH, "massFlowKgH");
  if (c.p1 <= c.p2) throw new PreSizingError("p1 must exceed p2");
  if (c.massFlowKgH === 0) return { cv: 0, status: "SHUTOFF_POINT", choked: false };
  const fp = finite(factors.fp, "fp", { min: 0, max: 1, exclusive: true });
  if (fp !== 1) throw new PreSizingError("FLP/xTP correction is not implemented");
  const dp = c.p1 - c.p2;
  let effectiveDp, y = 1, limit, choked;
  if (phase === "gas") {
    const xt = finite(factors.xt, "xt", { min: 0, max: 1, exclusive: true });
    const fk = finite(c.k, "k", { min: 1, exclusive: true }) / 1.4;
    limit = fk * xt;
    const x = Math.min(dp / c.p1, limit);
    y = 1 - x / (3 * limit);
    effectiveDp = x * c.p1;
    choked = dp / c.p1 >= limit;
  } else if (phase === "liquid") {
    const fl = finite(factors.fl, "fl", { min: 0, max: 1, exclusive: true });
    finite(c.pv, "pv", { min: 0 }); positive(c.pc, "pc");
    if (c.pv >= c.pc || c.p1 <= c.pv) throw new PreSizingError("invalid liquid vapor/critical pressure");
    const ff = .96 - .28 * Math.sqrt(c.pv / c.pc);
    limit = fl ** 2 * (c.p1 - ff * c.pv);
    effectiveDp = Math.min(dp, limit);
    choked = dp >= limit;
    if (c.p2 <= c.pv || choked) return { cv: positive(c.massFlowKgH / (27.3 * fp * Math.sqrt(effectiveDp * c.density)), "calculated Cv"),
      status: c.p2 <= c.pv ? "FLASHING_SPECIALIST_REVIEW" : "CHOKED_LIQUID_SPECIALIST_REVIEW", choked: true };
  } else throw new PreSizingError(`unsupported phase: ${phase}`);
  const cv = c.massFlowKgH / (27.3 * fp * y * Math.sqrt(effectiveDp * c.density));
  positive(cv, "calculated Cv");
  return { cv, status: "SCREENING_ONLY", choked, ...(phase === "gas" ? { expansionFactor: y } : {}) };
}

export function invertCurve(travel, cv, target) {
  positiveOrZero(target, "target Cv");
  if (!Array.isArray(travel) || !Array.isArray(cv) || travel.length !== cv.length || travel.length < 2) throw new PreSizingError("curve arrays must have matching lengths >=2");
  travel.forEach((v, i) => {
    finite(v, "travel", { min: 0, max: 100 });
    positiveOrZero(cv[i], "curve Cv");
    if (i && (v <= travel[i - 1] || cv[i] < cv[i - 1])) throw new PreSizingError("curve must have increasing travel and nondecreasing Cv");
  });
  if (target < cv[0]) return { status: "BELOW_TABULATED_RANGE", travelPercent: null };
  if (target > cv.at(-1)) return { status: "ABOVE_TABULATED_CAPACITY", travelPercent: null };
  const equal = cv.flatMap((v, i) => v === target ? [travel[i]] : []);
  if (equal.length > 1) return { status: "PLATEAU_INTERVAL", travelPercent: null, travelRangePercent: [equal[0], equal.at(-1)] };
  if (equal.length === 1) return { status: "TABULATED_POINT", travelPercent: equal[0] };
  const i = cv.findIndex(v => v > target);
  const value = travel[i - 1] + (target - cv[i - 1]) / (cv[i] - cv[i - 1]) * (travel[i] - travel[i - 1]);
  return { status: "INTERPOLATED", travelPercent: value };
}

function arrayAt(values, axis, position) {
  const i = axis.findIndex(x => x >= position);
  if (i <= 0) return values[0];
  return values[i - 1] + (values[i] - values[i - 1]) * (position - axis[i - 1]) / (axis[i] - axis[i - 1]);
}

function coefficients(normalized, table, curve) {
  const key = normalized.phase === "gas" ? "xt" : "fl";
  if (curve.factors?.[key]) return [{ values: curve.factors[key], basis: "manufacturer-row" }];
  const rows = table.factorRows.filter(r => key === "fl" ? /f.*l|reduced area|full area/i.test(r.label) : /x.*t/i.test(r.label));
  if (rows.length === 1) return [{ values: rows[0].values, basis: "manufacturer-table" }];
  if (normalized[key]) return normalized[key].map(v => ({ values: table.travelPercent.map(() => v), basis: "explicit-input" }));
  // Full/reduced-area factors cannot be silently assigned to an unclassified trim.
  return [];
}

function estimateCase(c, normalized, table, curve, coefficient) {
  if (c.massFlowKgH === 0) return { name: c.name, status: "SHUTOFF_POINT", travelPercent: null, requiredCv: 0 };
  const axis = table.travelPercent;
  const key = normalized.phase === "gas" ? "xt" : "fl";
  const calculateAt = position => requiredCv(c, normalized.phase, { fp: 1,
    [key]: arrayAt(coefficient.values, axis, position) });
  const demands = axis.map(calculateAt);
  const special = demands.find(d => d.status.endsWith("SPECIALIST_REVIEW"));
  if (special) return { name: c.name, status: special.status, travelPercent: null, requiredCv: special.cv };
  // Solve capacity vs demand using the travel-dependent manufacturer factors.
  const residual = position => arrayAt(curve.cv, axis, position) - calculateAt(position).cv;
  const sampled = axis.map(residual);
  if (sampled.some((v, i) => i && v < sampled[i - 1])) return { name: c.name, status: "NONMONOTONIC_CAPACITY_REVIEW", travelPercent: null };
  if (sampled[0] > 0) return { name: c.name, status: "BELOW_TABULATED_RANGE", travelPercent: null, requiredCv: demands[0].cv };
  if (sampled.at(-1) < 0) return { name: c.name, status: "ABOVE_TABULATED_CAPACITY", travelPercent: null, requiredCv: demands.at(-1).cv };
  const zeros = sampled.flatMap((v, i) => v === 0 ? [axis[i]] : []);
  if (zeros.length > 1) return { name: c.name, status: "PLATEAU_INTERVAL", travelPercent: null, travelRangePercent: [zeros[0], zeros.at(-1)] };
  let lo = axis[0], hi = axis.at(-1);
  for (let i = 0; i < 55; i++) {
    const mid = (lo + hi) / 2;
    if (residual(mid) >= 0) hi = mid; else lo = mid;
  }
  const position = (lo + hi) / 2;
  return { name: c.name, status: "ESTIMATED", travelPercent: position,
    requiredCv: calculateAt(position).cv, choked: calculateAt(position).choked };
}

export function screenCandidates(normalized, packages) {
  const filter = normalized.candidateFilter;
  for (const k of Object.keys(filter)) {
    if (!["series", "size", "rating", "characteristic", "flowDirection", "tableId", "trimFamily"].includes(k)) throw new PreSizingError(`unsupported candidate filter: ${k}`);
    text(filter[k], `candidateFilter.${k}`);
  }
  if (normalized.curveIds !== null && (!Array.isArray(normalized.curveIds) || !normalized.curveIds.length || normalized.curveIds.some(id => typeof id !== "string"))) throw new PreSizingError("curveIds must be a nonempty string array");
  const candidates = [], found = new Set();
  for (const pkg of packages) for (const table of pkg.tables) for (const curve of table.curves) {
    if (normalized.curveIds && !normalized.curveIds.includes(curve.id)) continue;
    if (Object.entries(filter).some(([k, v]) => (k === "size" ? !catalogSizeMatches(curve.size, v) : (k === "series" ? pkg.series : curve[k]) !== v))) continue;
    found.add(curve.id);
    const review = [...table.review, ...curve.review];
    if (curve.flowDirection === "see-table-context") review.push("表中流向取决于具体型号或未唯一说明，须核对后配置");
    const multiStage = /multi.stage|double.stage|variable resistance|\bVRT\b/i.test(table.trimFamily + " " + table.context);
    if (multiStage) review.push("多级/可变阻力内件需要专项方法；当前单级计算不用于自动推荐");
    if (pkg.series === "80000") review.push("三通阀需要端口工况复核，不自动推荐");
    const factors = coefficients(normalized, table, curve);
    if (!factors.length) review.push(`缺少唯一适用的${normalized.phase === "gas" ? "xT" : "FL"}；须提供来源或明确的敏感性假设`);
    const structuralIssue = table.review.length || curve.review.some(s => /非单调|尺寸未解析/.test(s));
    const scenarios = structuralIssue || multiStage ? [] : factors.map(coefficient => ({
      coefficientBasis: coefficient.basis,
      coefficientValues: coefficient.values,
      cases: normalized.cases.map(c => estimateCase(c, normalized, table, curve, coefficient)),
    }));
    const active = scenarios.flatMap(s => s.cases.filter(c => c.status !== "SHUTOFF_POINT"));
    const estimatedPoints = active.filter(c => c.status === "ESTIMATED");
    const estimated = active.length > 0 && active.every(c => c.status === "ESTIMATED");
    const window = normalized.preferredTravelPercent;
    const inside = estimated && (!window || active.every(c => c.travelPercent >= window[0] && c.travelPercent <= window[1]));
    const status = review.length ? "REVIEW_REQUIRED" : inside ? "PRIORITY_FOR_SOFTWARE_CHECK" : estimated ? "OUTSIDE_PREFERRED_WINDOW" : "RANGE_OR_REGIME_REVIEW";
    candidates.push({ id: curve.id, series: pkg.series, size: curve.size, rating: curve.rating,
      characteristic: curve.characteristic, flowDirection: curve.flowDirection, orifice: curve.orifice,
      trimFamily: curve.trimFamily, travel: curve.travel, ratedCv: curve.ratedCv, status, review, scenarios,
      source: { filename: pkg.source.filename, sha256: pkg.source.sha256, pdfPage: table.pdfPage, table: table.tableIndex, row: curve.sourceRow },
      tableContext: table.context,
      estimatedFraction: active.length ? estimatedPoints.length / active.length : 0,
      rankDistance: estimatedPoints.length && window ? Math.max(...estimatedPoints.map(c => Math.abs(c.travelPercent - (window[0] + window[1]) / 2))) : null });
  }
  if (normalized.curveIds?.some(id => !found.has(id))) throw new PreSizingError("one or more curveIds are unknown or excluded by the filter");
  const order = ["PRIORITY_FOR_SOFTWARE_CHECK", "OUTSIDE_PREFERRED_WINDOW", "RANGE_OR_REGIME_REVIEW", "REVIEW_REQUIRED"];
  return candidates.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status)
    || b.estimatedFraction - a.estimatedFraction
    || (a.rankDistance ?? Infinity) - (b.rankDistance ?? Infinity) || a.id.localeCompare(b.id));
}

export function calculatePreSizing(input, packages) {
  const normalized = normalizePreSizingInput(input);
  const coefficients = normalized.phase === "gas" ? normalized.xt : normalized.fl;
  const cases = normalized.cases.map(c => {
    if (c.massFlowKgH === 0) return { name: c.name, status: "SHUTOFF_POINT", requiredCvRange: [0, 0], results: [] };
    if (!coefficients) return { name: c.name, status: "CANDIDATE_FACTOR_REQUIRED", requiredCvRange: null, results: [] };
    const results = coefficients.map(value => ({ coefficient: value, ...requiredCv(c, normalized.phase,
      { fp: 1, [normalized.phase === "gas" ? "xt" : "fl"]: value }) }));
    return { name: c.name, status: results.some(r => r.status.endsWith("SPECIALIST_REVIEW")) ? "SPECIALIST_REVIEW" : "SCREENING_ONLY",
      requiredCvRange: [Math.min(...results.map(r => r.cv)), Math.max(...results.map(r => r.cv))], results };
  });
  return { schemaVersion: 1, status: "OFFLINE_SCREENING_ONLY", liveValidated: false, businessGatePass: false,
    normalized, cases, candidates: screenCandidates(normalized, packages),
    limitations: [...new Set(packages.flatMap(p => p.limitations))].concat([
      "未计算噪声、速度/Mach、汽蚀损伤、执行机构、供货可用性；预计开度不等于软件或现场保证。",
      "无黏度/Reynolds修正，无异径管FLP/xTP耦合；原始工况及适用性需要逐台核对。",
      "厂家曲线只在表内分段插值；曲线外不外推，候选不因初算越界自动永久排除。",
    ]) };
}

export function matchHistoricalFilter(record, filter) {
  return Object.entries(filter).every(([key, value]) => key !== 'tableId' &&
    (record[key] === value || record[key] === 'unknown'));
}

export function screenHistoricalCandidates(normalized, records) {
  // Explicit manufacturer curve selection must not silently expand to other products.
  if (normalized.curveIds) return [];
  const key = normalized.phase === 'gas' ? 'xt' : 'fl';
  const coefficients = normalized[key];
  const demands = coefficients ? normalized.cases.flatMap(c => coefficients.map(value =>
    requiredCv(c, normalized.phase, { fp: 1, [key]: value }))) : [];
  const maximum = demands.length ? Math.max(...demands.map(r => r.cv)) : null;
  const special = demands.some(d => d.status.endsWith('SPECIALIST_REVIEW'));
  return records.filter(r => r.sourceKind === 'software-dropdown' && matchHistoricalFilter(r, normalized.candidateFilter)).map(r => {
    const multiStage = /multi.stage|double.stage|VRT/i.test(r.trimType);
    return { ...r, status: special || multiStage ? 'HISTORICAL_SPECIALIST_REVIEW' : maximum === null || maximum === 0 ? 'HISTORICAL_FACTOR_OR_FLOW_REQUIRED'
      : r.trimFamily === 'unknown' ? 'HISTORICAL_CONFIG_REVIEW'
      : r.ratedCv >= maximum ? 'HISTORICAL_CAPACITY_CANDIDATE' : 'HISTORICAL_CAPACITY_SHORTFALL',
      requiredCvMax: maximum, capacityRatio: maximum > 0 ? r.ratedCv / maximum : null,
      travelPercent: null, openingStatus: 'NO_VERIFIED_CURVE',
      unresolvedFilterFields: Object.keys(normalized.candidateFilter).filter(k => r[k] === 'unknown'),
      currentAvailabilityVerified: false };
  }).sort((a,b) => {
    const order = ['HISTORICAL_CAPACITY_CANDIDATE','HISTORICAL_FACTOR_OR_FLOW_REQUIRED','HISTORICAL_CONFIG_REVIEW','HISTORICAL_SPECIALIST_REVIEW','HISTORICAL_CAPACITY_SHORTFALL'];
    return order.indexOf(a.status)-order.indexOf(b.status)
      || Number(b.manualCoverage === 'same-capacity-row')-Number(a.manualCoverage === 'same-capacity-row')
      || Math.abs((a.capacityRatio ?? 1)-1)-Math.abs((b.capacityRatio ?? 1)-1)
      || a.unresolvedFilterFields.length-b.unresolvedFilterFields.length || a.id.localeCompare(b.id);
  });
}

/** Split size alternatives only. Their physical meaning still comes from the table footnote. */
export function catalogSizeOptions(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new TypeError('缺少样本尺寸原文');
  const tokens = raw.replace(/\(\d+\)/g, '').replace(/[×X]/g, 'x').split(/\s+/).filter(Boolean);
  const options = [];
  for (const token of tokens) {
    if (['FTO', 'FTC'].includes(token)) continue;
    if (!/^\d+(?:\.\d+)?(?:x\d+(?:\.\d+)?){0,2}$/.test(token)) throw new Error('未识别样本尺寸：' + token);
    const dimensionsIn = token.split('x').map(Number);
    if (dimensionsIn.some(n => n <= 0)) throw new Error('样本尺寸须大于0');
    if (!options.some(o => o.token === token)) options.push({token, dimensionsIn});
  }
  if (!options.length) throw new Error('未找到样本尺寸');
  return options;
}

export function catalogSizeMatches(raw, wanted) {
  if (raw === wanted) return true;
  if (typeof wanted !== 'string') return false;
  try { return catalogSizeOptions(raw).some(option => option.token === wanted.replace(/[×X]/g, 'x')); }
  catch { return false; } // Unrecognized catalogue labels still support exact matching above.
}
