#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { checkCandidate } from './check-candidate.mjs';
import { screenActuators, actuatorCombinationInsufficient } from './actuator-screen.mjs';
import { selectSchemes } from './select-schemes.mjs';

const skill = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packaged = existsSync(resolve(skill, 'runtime/pre-sizing.mjs'));
const engine = packaged ? resolve(skill, 'runtime/pre-sizing.mjs') : resolve(skill, '../../../tools/valvstream/pre-sizing.mjs');
const capacityDirectory = packaged ? resolve(skill, 'capacity') : resolve(skill, '../valvstream-selection/data/capacity');
const sha = x => createHash('sha256').update(x).digest('hex');
const text = x => typeof x === 'string' && !!x.trim();
function unique(items, key, label) {
  if (!Array.isArray(items) || !items.length || items.some(x => !text(x?.[key])) || new Set(items.map(x => x[key])).size !== items.length)
    throw new Error(`${label}须为非空清单，${key}须非空且唯一`);
}
async function sourceHashes() {
  const paths = ['SKILL.md', 'scripts/run-review.mjs', 'scripts/check-candidate.mjs', 'scripts/actuator-review.mjs',
    'scripts/actuator-screen.mjs', 'scripts/select-schemes.mjs', 'scripts/catalog-size-options.mjs', 'data/actuator-catalog.json'];
  const hashes = {};
  for (const path of paths) hashes[path] = sha(await readFile(resolve(skill, path)));
  return hashes;
}
async function capacity(valve) {
  if (!valve.capacityInput) return null;
  const { calculatePreSizing } = await import(pathToFileURL(engine));
  const directory = capacityDirectory;
  const index = JSON.parse(await readFile(resolve(directory, 'index.json'), 'utf8'));
  const packages = [], hashes = {};
  for (const [series, meta] of Object.entries(index.series)) {
    if (valve.capacityInput.preSizing?.candidateFilter?.series && valve.capacityInput.preSizing.candidateFilter.series !== series) continue;
    if (!/^\d{5}\.json$/.test(meta.file)) throw new Error('厂家曲线文件名无效');
    const data = await readFile(resolve(directory, meta.file));
    if (sha(data) !== meta.sha256) throw new Error('厂家曲线指纹不一致：' + series);
    hashes[series] = sha(data); packages.push(JSON.parse(data));
  }
  const result = calculatePreSizing(valve.capacityInput, packages);
  const actual = result.normalized.cases.map(c => ({name:c.name,massFlowKgH:c.massFlowKgH}));
  if (!isDeepStrictEqual(actual, valve.sourceCases.map(c => ({name:c.name,massFlowKgH:c.massFlowKgH}))))
    throw new Error(`${valve.id}：容量计算工况与本台源工况不一致`);
  return { result, hashes, engineSha256:sha(await readFile(engine)) };
}
function candidateInput(valve, candidate, calculated) {
  const input = structuredClone(candidate.check || {});
  if (input.actuatorReview || input.forceScreen) throw new Error('执行机构输出由统一程序计算，不接受候选自填输出力');
  input.sourceCases = structuredClone(valve.sourceCases);
  input.baseline = structuredClone(valve.baseline);
  input.pipeNominalMm = structuredClone(valve.pipeNominalMm);
  if (!calculated) return { input, curve:null };
  const curve = calculated.result.candidates.find(c => c.id === candidate.curveId);
  if (!curve) throw new Error(`${valve.id}/${candidate.id}：未绑定本轮计算的厂家曲线`);
  input.candidate = {...input.candidate, ratedCv:curve.ratedCv};
  input.cases = valve.sourceCases.map(source => {
    const extra = (input.cases || []).find(c => c.name === source.name) || {};
    const points = curve.scenarios.flatMap(s => s.cases.filter(c => c.name === source.name));
    const complete = points.length > 0 && points.every(c => ['ESTIMATED','SHUTOFF_POINT'].includes(c.status));
    return {...extra, ...source,
      // An out-of-range curve can still have a computed demand; keep it so insufficiency is not hidden as missing data.
      requiredCv:points.length && points.every(c => typeof c.requiredCv === 'number' && Number.isFinite(c.requiredCv)) ? Math.max(...points.map(c => c.requiredCv)) : null,
      estimatedTravelPercent:complete && source.massFlowKgH > 0 ? Math.max(...points.map(c => c.travelPercent)) : null};
  });
  input.calculationBasis = {type:'estimate',description:'本轮调用随包容量引擎并反查厂家曲线；各显式系数情景取最大需求/开度',
    assumptions:[calculated.result.normalized.assessmentBasis || '适用性及物性来源见capacityInput', ...calculated.result.limitations]};
  input.evidence = [...(input.evidence || []), curve.id, JSON.stringify(curve.source)];
  return {input, curve};
}
export async function runReview(input) {
  if (input?.schemaVersion !== 1) throw new Error('批量输入schemaVersion必须为1');
  unique(input.valves, 'id', '阀门');
  const output = {schemaVersion:2, status:'OFFLINE_REVIEW', liveValidated:false, engineeringQualified:false,
    inputSha256:sha(JSON.stringify(input)), sourceHashes:await sourceHashes(), valves:[]};
  for (const valve of input.valves) {
    unique(valve.sourceCases, 'name', `${valve.id}源工况`);
    if (!Array.isArray(valve.candidates)) throw new Error('须提供候选清单');
    if (valve.candidates.length) unique(valve.candidates, 'id', `${valve.id}候选`);
    else if (!text(valve.noCandidateReason)) throw new Error('无候选仍须保留本台，并说明排查结果/缺项');
    if (!text(valve.source)) throw new Error(`${valve.id}缺原始资料引用`);
    const calculated = await capacity(valve), checks = new Map(), actuation = [];
    for (const candidate of valve.candidates) {
      if (!['capacity','special'].includes(candidate.kind) || !text(candidate.route) || !text(candidate.decisionBasis))
        throw new Error(`${valve.id}/${candidate.id}须说明kind、路线和取舍依据`);
      if (candidate.kind === 'special') {
        if (!text(candidate.specialAssessment)) throw new Error('特殊配置须单列工程依据，不冒充基础路线通过');
        checks.set(candidate.id,{status:'SPECIAL_REVIEW_REQUIRED',rejected:[],missing:[],pending:[candidate.specialAssessment],
          displayHolds:typeof candidate.actuation?.required==='boolean'?[]:['须明确此特殊方案是否涉及执行机构或受力变更（actuation.required）']});
      } else {
        const {input:check,curve} = candidateInput(valve,candidate,calculated);
        const reviewed = checkCandidate(check);
        // Actuation is evaluated below from manufacturer data; the legacy empty-input reminder is replaced.
        reviewed.pending = reviewed.pending.filter(s => !s.startsWith('尚未完成执行机构静力初筛') && !s.startsWith('未提供执行机构对照'));
        delete reviewed.actuatorReview;
        checks.set(candidate.id,{...reviewed,input:check,curve});
      }
      let travelIn = candidate.actuation?.travelIn;
      const curve = checks.get(candidate.id).curve;
      if (curve && /^\d+(\.\d+)?$/.test(curve.travel)) {
        if (travelIn != null && travelIn !== Number(curve.travel)) throw new Error('执行机构行程与绑定曲线不一致');
        travelIn = Number(curve.travel);
      }
      actuation.push({...candidate.actuation,id:candidate.id,travelIn,status:candidate.upstreamPriority});
    }
    const actuators = screenActuators({...valve.actuator,candidates:actuation});
    const records = valve.candidates.map(candidate => {
      const {curve, ...check} = checks.get(candidate.id);
      const actuatorScreen = actuators.candidates?.find(c => c.id === candidate.id) ?? null;
      const rejected = [...(candidate.rejected || []), ...check.rejected];
      const holds = [...(check.displayHolds || [])];
      const relevant = candidate.kind === 'capacity' || candidate.actuation?.required === true;
      const options = actuatorScreen?.combinations || [];
      const chosen = candidate.actuation?.selection;
      let selected;
      if (chosen != null) {
        if (!relevant) throw new Error('未涉及执行机构的特殊方案不能另选执行机构组合');
        if (typeof chosen !== 'object' || !chosen.type || chosen.size == null || !Number.isFinite(chosen.travelIn) || !Object.hasOwn(chosen, 'spring'))
          throw new Error(`${valve.id}/${candidate.id}：采用执行机构须完整给type/size/travelIn/spring`);
        selected = options.find(c => c.type === String(chosen.type) && c.size === String(chosen.size) && c.travelIn === chosen.travelIn && isDeepStrictEqual(c.spring, chosen.spring));
        if (!selected) throw new Error(`${valve.id}/${candidate.id}：采用执行机构未匹配本轮枚举组合`);
      }
      const insufficient = actuatorCombinationInsufficient;
      if (relevant && actuatorScreen?.newLoadComplete) {
        if (selected && insufficient(selected)) rejected.push('所选执行机构不能覆盖当前明确的新需求');
        else if (!selected && options.length && actuatorScreen.coverage.complete && options.every(insufficient))
          rejected.push('本轮已核验目录中的全部执行机构组合均不能覆盖当前明确的新需求');
      }
      const unresolvedFailure = relevant && !selected && options.length && options.every(insufficient) && !actuatorScreen.coverage.complete;
      if (unresolvedFailure) holds.push('已计算组合不足，仍有未覆盖组合；补资料或明确采用配置后再列主表');
      return {...candidate, check:{...check,curveRef:curve?.id ?? null}, actuatorRef:actuatorScreen?.id ?? null,
        rejected, notPreparedReason:[candidate.notPreparedReason,...holds].filter(Boolean).join('；') || null};
    });
    // Enumerate every candidate before applying any display limit, including archived short-travel routes.
    const selection = selectSchemes(records, input.displayLimit ?? 3);
    output.valves.push({id:valve.id,source:valve.source,sourceCases:valve.sourceCases,baseline:valve.baseline,
      noCandidateReason:valve.noCandidateReason ?? null,capacity:calculated,actuators,...selection});
  }
  output.coverage = {valves:output.valves.length,candidates:output.valves.reduce((n,v)=>n+v.records.length,0),
    sourceCases:output.valves.reduce((n,v)=>n+v.sourceCases.length,0)};
  const capacityRecords = output.valves.flatMap(v=>v.records.filter(r=>r.kind==='capacity'));
  output.checks = {capacityCasesComplete:capacityRecords.length>0 && capacityRecords.every(r=>r.check.coverage.complete),
    actuatorEnumerationComplete:output.valves.every(v=>v.actuators.calculationComplete),
    newActuatorLoadsComplete:output.valves.every(v=>v.actuators.newLoadComplete),
    sourceAndExportedArtifactReview:'REQUIRED_SEPARATELY'};
  return output;
}
export function verifyReviewResults(actual, saved) {
  const current = structuredClone(actual), previous = structuredClone(saved);
  for (const r of [current,previous]) if (!/^[a-f0-9]{64}$/.test(r.sourceHashes?.['SKILL.md'] || '')) throw new Error('缺少有效的Skill规则来源指纹');
  const ruleVersionChanged = current.sourceHashes['SKILL.md'] !== previous.sourceHashes['SKILL.md'];
  if (current.sourceHashes) delete current.sourceHashes['SKILL.md'];
  if (previous.sourceHashes) delete previous.sourceHashes['SKILL.md'];
  if (!isDeepStrictEqual(current, previous)) throw new Error('交付计算与当前输入/程序重算不一致；历史版本请用其冻结程序核对');
  return {reproduced:true, ruleVersionChanged, ruleReviewRequired:ruleVersionChanged};
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [inputPath, outputPath, flag] = process.argv.slice(2);
    if (!inputPath || !outputPath || (flag && flag !== '--verify') || process.argv.length > 5)
      throw new Error('Usage: node run-review.mjs input.json result.json [--verify]');
    const result = await runReview(JSON.parse(await readFile(inputPath,'utf8')));
    if (flag === '--verify') {
      const verified = verifyReviewResults(result, JSON.parse(await readFile(outputPath,'utf8')));
      console.log(JSON.stringify({...verified,...result.coverage,checks:result.checks,engineeringQualified:false}));
    } else {
      await writeFile(outputPath,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
      console.log(JSON.stringify({output:outputPath,...result.coverage,checks:result.checks,engineeringQualified:false}));
    }
  } catch(e) { console.error(e.message); process.exitCode=1; }
}
