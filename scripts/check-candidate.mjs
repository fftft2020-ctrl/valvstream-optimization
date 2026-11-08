#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { reviewActuator } from './actuator-review.mjs';

const number = (x, zero = false) => typeof x === 'number' && Number.isFinite(x) && (zero ? x >= 0 : x > 0);
const object = x => x && typeof x === 'object' && !Array.isArray(x);
const text = x => typeof x === 'string' && !!x.trim();
const relations = ['=', '<', '<=', '>', '>='];
function compareNoise(value, relation, limit, limitRelation) {
  if (relation === '=') return (limitRelation === '<' ? value < limit : value <= limit) ? 'WITHIN_LIMIT' : 'EXCEEDS_LIMIT';
  if (relation === '<' && value <= limit || relation === '<=' && (value < limit || value === limit && limitRelation === '<=')) return 'WITHIN_LIMIT';
  if (relation === '>' && value >= limit || relation === '>=' && (value > limit || value === limit && limitRelation === '<')) return 'EXCEEDS_LIMIT';
  return 'INDETERMINATE';
}

// Bounded engineering checks only; source truth, model applicability and trial value require separate review.
export function checkCandidate(input) {
  const rejected = [], missing = [], deviations = [], pending = [
    '软件核验实际候选、完整执行机构负荷、附件与动作时间；本结果不等于选型通过',
    '本地引擎未实现完整异径管修正、黏度修正及气蚀损伤模型',
    '逐路线比较收益、原噪声、速度增量、开度和余量后再安排试选；检查状态不决定优先级'
  ];
  if (!object(input)) throw new TypeError('candidate input must be an object');
  const { direction, baseline = {}, candidate = {}, pipeNominalMm = {}, calculationBasis } = input;
  if (!['body', 'cv'].includes(direction)) rejected.push('本检查器仅支持 body / cv 两条基础路线；特殊方案须单独工程评估');
  for (const side of ['inlet', 'outlet']) {
    if (!number(pipeNominalMm?.[side])) missing.push(`缺少有效的 ${side} 管道公称口径`);
    else if (number(candidate?.bodyNominalMm) && candidate.bodyNominalMm < pipeNominalMm[side] / 2)
      rejected.push(`${side}：候选口径小于管道公称口径的一半`);
  }
  for (const [name, config] of [['原方案', baseline], ['候选', candidate]]) {
    for (const key of ['bodyNominalMm', 'ratedCv']) if (!number(config?.[key])) missing.push(`${name} ${key} 缺少有效数值`);
    if (!object(config?.packing) || !Object.keys(config.packing).length) missing.push(`${name} 缺少完整填料配置`);
  }
  if (object(baseline?.packing) && object(candidate?.packing) && !isDeepStrictEqual(baseline.packing, candidate.packing)) rejected.push('候选改变了原填料配置');
  if (number(baseline?.bodyNominalMm) && number(candidate?.bodyNominalMm)) {
    if (direction === 'body' && candidate.bodyNominalMm >= baseline.bodyNominalMm) rejected.push('body 路线必须缩小阀体');
    if (direction === 'cv' && candidate.bodyNominalMm !== baseline.bodyNominalMm) rejected.push('cv 路线必须保持阀体口径');
  }
  if (direction === 'cv' && number(baseline?.ratedCv) && number(candidate?.ratedCv) && candidate.ratedCv >= baseline.ratedCv) rejected.push('cv 路线必须减小额定 Cv');
  if (!Array.isArray(input.evidence) || !input.evidence.length || !input.evidence.every(text)) missing.push('缺少计算及来源证据引用');
  const basisType = object(calculationBasis) && ['independent', 'estimate', 'software', 'reference'].includes(calculationBasis.type) ? calculationBasis.type : 'unknown';
  if (basisType === 'unknown' || !text(calculationBasis?.description)) missing.push('缺少明确计算依据类型及说明；旧格式不默认独立初算');
  if (basisType === 'reference') missing.push('原报告引用不能代替候选独立初算、有条件估算或软件结果');
  if (basisType === 'estimate') {
    if (!Array.isArray(calculationBasis.assumptions) || !calculationBasis.assumptions.length || !calculationBasis.assumptions.every(text)) missing.push('有条件估算必须说明具体假设');
    pending.push('估算/校准不是独立验证，须复核候选实际系数和适用性');
  }

  const source = new Map(), names = new Set(), rows = [];
  let sourceValid = Array.isArray(input.sourceCases) && input.sourceCases.length > 0, coverageValid = true;
  if (!sourceValid) missing.push('缺少完整源工况清单 sourceCases，不能确认是否漏项');
  for (const c of Array.isArray(input.sourceCases) ? input.sourceCases : []) {
    if (!object(c) || !text(c.name) || source.has(c.name) || !number(c.massFlowKgH, true)) { sourceValid = false; missing.push('源工况名称须非空唯一，质量流量须为有效数值'); continue; }
    source.set(c.name, c.massFlowKgH);
  }
  if (!Array.isArray(input.cases) || !input.cases.length) { coverageValid = false; missing.push('缺少工况计算结果'); }
  for (const c of Array.isArray(input.cases) ? input.cases : []) {
    if (!object(c) || !text(c.name) || names.has(c.name)) { coverageValid = false; missing.push('计算工况名称须非空唯一'); continue; }
    names.add(c.name);
    if (!number(c.massFlowKgH, true)) { coverageValid = false; missing.push(`${c.name}：质量流量无效`); }
    if (source.has(c.name) && c.massFlowKgH !== source.get(c.name)) { coverageValid = false; rejected.push(`${c.name}：候选流量与源工况不一致`); }
    if (!number(c.requiredCv, true)) missing.push(`${c.name}：缺少有效需求 Cv`);
    else if (number(candidate?.ratedCv) && c.requiredCv > candidate.ratedCv) rejected.push(`${c.name}：容量不足`);
    const stopped = c.massFlowKgH === 0;
    if (stopped && c.requiredCv !== 0) rejected.push(`${c.name}：停流点需求 Cv 必须为0`);
    if (!stopped) {
      const travel = c.estimatedTravelPercent;
      if (!number(travel) || travel === 0) missing.push(`${c.name}：缺少适用曲线的预计开度`);
      else if (travel >= 100) rejected.push(`${c.name}：预计开度达到或超过全开`);
      else if (travel >= 90) pending.push(`${c.name}：接近全开，应比较相邻候选；90%不是通用不合格线`);
      if (c.travelLimits != null) {
        const l = c.travelLimits;
        if (!object(l) || !number(l.minPercent, true) || !number(l.maxPercent, true) || l.maxPercent > 100 || l.minPercent > l.maxPercent) missing.push(`${c.name}：客户硬开度限制无效`);
        else if (number(travel) && (travel < l.minPercent || travel > l.maxPercent)) rejected.push(`${c.name}：超出客户明确硬开度限制`);
      }
    }
    let velocityMps = null, roughVelocityMps = null;
    if (stopped) velocityMps = 0;
    else if (number(c.massFlowKgH) && number(c.outletDensityKgM3) && number(c.outletDiameterMm)) {
      const v = c.massFlowKgH / 3600 / c.outletDensityKgM3 / (Math.PI * (c.outletDiameterMm / 1000) ** 2 / 4);
      if (!number(v)) missing.push(`${c.name}：流速计算超出有效数值范围`);
      else if (c.outletAreaBasis === 'actual' && c.outletDensityBasis === 'verified') velocityMps = v;
      else {
        roughVelocityMps = v;
        missing.push(`${c.name}：出口面积或密度未经实际核实，流速仅为粗估`);
        if (!['actual', 'nominal'].includes(c.outletAreaBasis) || !['verified', 'assumed'].includes(c.outletDensityBasis)) missing.push(`${c.name}：缺少有效流速依据类型`);
        if (!text(c.velocityAssumptions)) missing.push(`${c.name}：流速粗估须说明面积/密度假设`);
      }
    } else missing.push(`${c.name}：缺少有效质量流量、出口密度或实际出口直径`);
    if (c.velocityLimitMps != null && !number(c.velocityLimitMps)) missing.push(`${c.name}：流速限值无效`);
    else if (number(c.velocityLimitMps)) {
      if (velocityMps !== null && velocityMps > c.velocityLimitMps) deviations.push(`${c.name}：出口流速 ${velocityMps.toFixed(3)} m/s 超过 ${c.velocityLimitMps} m/s，不能当作合格`);
      if (roughVelocityMps !== null && roughVelocityMps > c.velocityLimitMps) pending.push(`${c.name}：流速粗估高于给定限值，须实际流道与物性核验；不作正式验收`);
    }
    let newNoiseDbA = null, noiseDifferenceDb = null, noiseAssessment = 'NOT_PREDICTED';
    const limitValid = number(c.noiseLimitDbA, true) && ['<', '<='].includes(c.noiseLimitRelation);
    if (c.noiseLimitDbA != null && !limitValid) missing.push(`${c.name}：噪声限值须有有效数值及 < 或 <= 关系`);
    if (c.noiseDbA != null) {
      if (!number(c.noiseDbA, true) || !relations.includes(c.noiseRelation) || !['prediction', 'original-report'].includes(c.noiseBasis)) missing.push(`${c.name}：噪声须区分新预测/原报告，并保留有效数值及界限关系`);
      else if (c.noiseBasis === 'prediction') {
        newNoiseDbA = c.noiseDbA;
        noiseAssessment = limitValid ? compareNoise(c.noiseDbA, c.noiseRelation, c.noiseLimitDbA, c.noiseLimitRelation) : 'NO_LIMIT';
        if (!stopped && noiseAssessment === 'EXCEEDS_LIMIT') {
          noiseDifferenceDb = c.noiseRelation === '=' ? +(c.noiseDbA - c.noiseLimitDbA).toFixed(3) : null;
          deviations.push(`${c.name}：新噪声 ${c.noiseRelation}${c.noiseDbA} dBA 不满足 ${c.noiseLimitRelation}${c.noiseLimitDbA} dBA${noiseDifferenceDb === null ? '，仅界限判定' : `，数值差 ${noiseDifferenceDb} dB`}；需对应偏差接受`);
        }
        if (!stopped && noiseAssessment === 'INDETERMINATE') pending.push(`${c.name}：噪声界限不足以确定符合限值，不能当作合格`);
      }
    }
    if (newNoiseDbA === null && !stopped) pending.push(`${c.name}：候选新噪声未可靠计算，原报告噪声只作基准`);
    rows.push({ name: c.name, velocityMps, roughVelocityMps, noiseAssessment, newNoiseDbA,
      newNoiseRelation: newNoiseDbA === null ? null : c.noiseRelation, noiseDifferenceDb });
  }
  const omitted = [...source.keys()].filter(name => !names.has(name)), unexpected = [...names].filter(name => !source.has(name));
  if (omitted.length) missing.push('源工况未计算：' + omitted.join('、'));
  if (sourceValid && unexpected.length) rejected.push('计算工况不在源清单：' + unexpected.join('、'));
  const coverage = { complete: !!sourceValid && coverageValid && !omitted.length && !unexpected.length,
    expected: source.size, provided: names.size, omitted, unexpected };
  const noiseRequired = [...source].filter(([, flow]) => flow > 0).map(([name]) => name);
  const noisePredicted = noiseRequired.filter(name => rows.some(r => r.name === name && r.newNoiseDbA !== null));
  const noiseCoverage = { complete: coverage.complete && noisePredicted.length === noiseRequired.length,
    expected: noiseRequired.length, predicted: noisePredicted.length,
    omitted: noiseRequired.filter(name => !noisePredicted.includes(name)) };
  const velocityRequired = [...source].filter(([, flow]) => flow > 0).map(([name]) => name);
  const velocityCalculated = velocityRequired.filter(name => rows.some(r => r.name === name && r.velocityMps !== null));
  const velocityRough = velocityRequired.filter(name => rows.some(r => r.name === name && r.roughVelocityMps !== null));
  const velocityCoverage = { complete: coverage.complete && velocityCalculated.length === velocityRequired.length,
    expected: velocityRequired.length, calculated: velocityCalculated.length, rough: velocityRough.length,
    omitted: velocityRequired.filter(name => !velocityCalculated.includes(name) && !velocityRough.includes(name)),
    unverified: velocityRough };
  let hydraulicClosingLowerBoundN = null;
  if (input.forceScreen != null) {
    const f = input.forceScreen;
    if (!object(f) || !['shutoffMPa', 'netPressureAreaMm2', 'availableClosingN'].every(k => number(f[k]))) missing.push('关闭静力初筛参数无效');
    else {
      hydraulicClosingLowerBoundN = f.shutoffMPa * f.netPressureAreaMm2;
      if (!number(hydraulicClosingLowerBoundN)) { hydraulicClosingLowerBoundN = null; missing.push('关闭静力计算超出有效数值范围'); }
      else if (f.availableClosingN <= hydraulicClosingLowerBoundN) rejected.push('关闭可用力不足以覆盖液压力及其他负荷');
      pending.push('关闭力仅与液压力下界比较，密封/摩擦/规定余量及开启方向仍须核验');
    }
  } else pending.push('尚未完成执行机构静力初筛；不得据 Cv 变化宣称执行机构可缩小');
  const actuatorReview=reviewActuator(input.actuatorReview);
  if (input.actuatorReview!=null) {
    missing.push(...actuatorReview.missing);
    for (const c of actuatorReview.comparisons) if(c.candidateVerdict==='INSUFFICIENT') rejected.push(`${c.model}：当前候选需求下执行机构输出不足`);
  } else pending.push('未提供执行机构对照；容量检查状态不能作为执行机构或优化交付完成');
  return {
    schemaVersion: 2, actuatorReview, status: rejected.length ? 'REJECTED' : missing.length ? 'NEEDS_DATA' : deviations.length ? 'DEVIATION_REVIEW' : 'READY_FOR_SOFTWARE_CHECK',
    calculationBasis: basisType, coverage, noiseCoverage, velocityCoverage, trialPriority: 'NOT_ASSESSED',
    liveValidated: false, businessGatePass: false,
    rejected, missing, deviations, pending, cases: rows, hydraulicClosingLowerBoundN
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!process.argv[2] || process.argv.length !== 3) throw new Error('Usage: node check-candidate.mjs candidate.json');
    console.log(JSON.stringify(checkCandidate(JSON.parse(await readFile(process.argv[2], 'utf8'))), null, 2));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
