#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile, link, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { calculatePreSizing, screenHistoricalCandidates, matchHistoricalFilter, catalogSizeMatches, PreSizingError } from "./pre-sizing.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DATA = join(ROOT, ".agents/skills/valvstream-selection/data/capacity");
export const digest = value => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : stable(value)).digest("hex");
function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
}
const json = path => readFile(path, "utf8").then(JSON.parse);

export async function loadCapacityLibrary(series, dataDir = DATA) {
  const indexBytes = await readFile(join(dataDir, "index.json"));
  const index = JSON.parse(indexBytes);
  if (index.schemaVersion !== 1 || !index.series) throw new PreSizingError("invalid capacity index");
  try {
    const manifest = await readFile(join(dataDir, "../product-source-manifest.json"));
    if (digest(manifest) !== index.sourceManifestSha256) throw new PreSizingError("product source manifest changed; rebuild/review capacity library before use");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    // A standalone frozen library carries its own pinned source records in index.json.
  }
  const ids = series ? [series] : Object.keys(index.series);
  const packages = [];
  for (const id of ids) {
    if (!/^\d{5}$/.test(id) || !index.series[id] || index.series[id].file !== `${id}.json`) throw new PreSizingError(`unknown series: ${id}`);
    const bytes = await readFile(join(dataDir, `${id}.json`));
    if (digest(bytes) !== index.series[id].sha256) throw new PreSizingError(`capacity data hash mismatch: ${id}`);
    const pkg = JSON.parse(bytes);
    if (pkg.schemaVersion !== 1 || pkg.series !== id || pkg.source.sha256 !== index.series[id].sourceSha256) throw new PreSizingError(`capacity source mismatch: ${id}`);
    packages.push(pkg);
  }
  let history = [];
  if (index.history) {
    if (index.history.file !== 'history.json') throw new PreSizingError('invalid historical capacity filename');
    const bytes = await readFile(join(dataDir, 'history.json'));
    if (digest(bytes) !== index.history.sha256) throw new PreSizingError('historical capacity hash mismatch');
    const supplement = JSON.parse(bytes);
    if (supplement.schemaVersion !== 1 || !Array.isArray(supplement.records)) throw new PreSizingError('invalid historical capacity library');
    for (const id of ids) if (supplement.manufacturerFileHashes?.[id] !== index.series[id].sha256) throw new PreSizingError('historical manual matching is stale; rebuild supplement');
    try {
      const manifest = await readFile(join(dataDir, '../capacity-history-sources.json'));
      if (digest(manifest) !== supplement.sourceManifestSha256) throw new PreSizingError('historical sources changed; rebuild supplement');
    } catch(e) { if (e.code !== 'ENOENT') throw e; }
    history = supplement.records.filter(r => ids.includes(r.series));
    for (const r of history) {
      if (!/^history-\d{5}-[a-f0-9]{12}$/.test(r.id) || !Number.isFinite(r.ratedCv) || r.ratedCv <= 0 || r.curve !== null || !r.evidence?.length) throw new PreSizingError('invalid historical capacity record');
    }
  }
  let dropdowns=[];
  if(index.dropdowns){
    if(index.dropdowns.file!=='dropdowns.json') throw new PreSizingError('invalid dropdown filename');
    const bytes=await readFile(join(dataDir,'dropdowns.json'));
    if(digest(bytes)!==index.dropdowns.sha256) throw new PreSizingError('dropdown hash mismatch');
    const catalog=JSON.parse(bytes);
    if(catalog.schemaVersion!==1 || !Array.isArray(catalog.groups)) throw new PreSizingError('invalid dropdown catalog');
    try {
      if(digest(await readFile(join(dataDir,'../capacity-dropdown-sources.json')))!==catalog.sourceManifestSha256) throw new PreSizingError('dropdown sources changed');
    } catch(e){if(e.code!=='ENOENT')throw e;}
    dropdowns=catalog.groups.filter(g=>ids.includes(g.configuration.series));
    for(const g of dropdowns) if(!/^dropdown-\d{5}-[a-f0-9]{12}$/.test(g.id) || g.optionCount!==g.options.length || new Set(g.options.map(o=>o.ratedCv)).size!==g.optionCount || g.options.some(o=>!Number.isFinite(o.ratedCv)||o.ratedCv<=0) || !g.evidence.length) throw new PreSizingError('invalid dropdown option set');
  }
  return { index, packages, history, dropdowns, dataHash: digest({ indexHash: digest(indexBytes), files: ids.map(id => index.series[id].sha256) }) };
}

export function buildCapacityDirectory({ packages, dropdowns, dataHash }) {
  const handbookGroups = [];
  const adjustableRanges = [];
  const coverage = [];
  for (const pkg of packages) {
    const groups = new Map();
    for (const table of pkg.tables) for (const curve of table.curves) {
      const configuration = { series: pkg.series, ...Object.fromEntries(
        ['characteristic','size','rating','trimFamily','flowDirection','orifice','travel'].map(k => [k, curve[k] ?? null])) };
      // Keep source scopes separate: combined sizes/classes and footnotes are not individual software configurations.
      const key = digest({ tableId: table.id, configuration });
      if (!groups.has(key)) groups.set(key, {
        id: `handbook-${key.slice(0,16)}`, sourceKind: 'manufacturer-handbook', configuration,
        source: pkg.source, tableId: table.id, pdfPage: table.pdfPage, context: table.context,
        review: table.review ?? [], limitations: pkg.limitations, variants: [],
        softwareOptionSetVerified: false,
      });
      groups.get(key).variants.push({ curveId: curve.id, ratedCv: curve.ratedCv,
        sourceRow: curve.sourceRow, metadataRaw: curve.metadataRaw, review: curve.review });
    }
    for (const group of groups.values()) {
      group.ratedCvValues = [...new Set(group.variants.map(v => v.ratedCv))].sort((a,b) => a-b);
      group.uniqueCvCount = group.ratedCvValues.length;
      handbookGroups.push(group);
    }
    if (pkg.capacitySettings?.length) adjustableRanges.push({ series: pkg.series, source: pkg.source,
      sourceKind: 'manufacturer-adjustable-ranges', settings: pkg.capacitySettings,
      sourceText: pkg.capacitySettingsSourceText, limitations: pkg.limitations,
      softwareOptionSetVerified: false });
    coverage.push({ series: pkg.series, handbookGroups: groups.size,
      handbookRows: pkg.tables.reduce((n,t) => n+t.curves.length,0),
      adjustableRanges: pkg.capacitySettings?.length ?? 0,
      completeStoredDropdownGroups: dropdowns.filter(g => g.configuration.series === pkg.series).length,
      allSoftwareConfigurationsCovered: false,
      outstanding: ['缺少完整下拉框证据的具体配置仍待补录；不得由手册范围或历史选中值拼成软件选项。'] });
  }
  return { schemaVersion: 1, dataHash, scope: '仅覆盖已登记资料；不代表厂家或软件全部产品配置',
    interpretation: '手册按原表配置分组，组内Cv数值去重但保留全部原始行。软件组保留完整配置和原选项；两类不混合、不推断等价。',
    coverage, handbookGroups, adjustableRanges, softwareDropdownGroups: dropdowns };
}

async function immutableWrite(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, content, { flag: "wx", mode: 0o600 });
  try {
    // Publish only complete files; parallel readers never see a partially written JSON.
    try { await link(temp, path); }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (await readFile(path, "utf8") !== content) throw new PreSizingError(`refusing to overwrite different content: ${path}`);
    }
  } finally { await unlink(temp); }
}

export function bindDropdown(input, groups) {
  const id=input.preSizing?.dropdownId;
  if(!id)return null;
  const group=groups.find(g=>g.id===id);
  if(!group)throw new PreSizingError('unknown dropdownId; do not substitute a different size/trim');
  if(input.preSizing.curveIds)throw new PreSizingError('choose dropdownId or curveIds, not both');
  for(const [k,v] of Object.entries(input.preSizing.candidateFilter??{})) {
    if(group.configuration[k]!==v)throw new PreSizingError(`dropdown configuration conflict: ${k}`);
  }
  return group;
}

export async function runPreSizing(input, { outDir, cacheDir, dataDir = DATA } = {}) {
  if (!outDir) throw new PreSizingError("outDir required");
  cacheDir ??= join(outDir, "cache");
  const series = input?.preSizing?.candidateFilter?.series;
  const library = await loadCapacityLibrary(series, dataDir);
  const dropdown=bindDropdown(input,library.dropdowns);
  const codeFiles = await Promise.all([readFile(fileURLToPath(import.meta.url)), readFile(new URL("./pre-sizing.mjs", import.meta.url))]);
  const version = { engineHash: digest(Buffer.concat(codeFiles)), dataHash: library.dataHash };
  const key = digest({ input, ...version });
  const cachePath = join(cacheDir, `${key}.json`);
  let result, cacheHit = false;
  try {
    const entry = await json(cachePath);
    if (entry.key !== key || entry.resultHash !== digest(entry.result) || stable(entry.version) !== stable(version)) throw new PreSizingError("cache integrity mismatch");
    result = entry.result;
    cacheHit = true;
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    const calculationInput=dropdown?{...input,preSizing:{...input.preSizing,candidateFilter:Object.fromEntries(['series','size','characteristic','trimFamily','flowDirection','rating'].map(k=>[k,dropdown.configuration[k]]))}}:input;
    result = calculatePreSizing(calculationInput, library.packages);
    // Selected historical values are observations, never a complete menu of available capacities.
    result.historicalCandidates=[];
    result.dropdownSelection=dropdown;
    if(dropdown){
      result.candidates=[]; // No curve equivalence is inferred from a matching rated Cv alone.
      result.normalized.candidateFilter={...dropdown.configuration};
      const rows=dropdown.options.map(o=>({...dropdown.configuration,id:`${dropdown.id}-cv${o.ratedCv}`,dropdownId:dropdown.id,ratedCv:o.ratedCv,optionKey:o.key,
        sourceKind:'software-dropdown',curve:null,manualCoverage:'complete-dropdown-option',evidence:dropdown.evidence}));
      result.historicalCandidates=screenHistoricalCandidates(result.normalized,rows);
    }
    const entry = { key, version, resultHash: digest(result), result };
    await immutableWrite(cachePath, JSON.stringify(entry) + "\n");
  }
  const evidencePath = resolve(outDir, `${key}.json`);
  const summaryPath = resolve(outDir, `${key}.md`);
  await immutableWrite(evidencePath, JSON.stringify({ key, version, input, result }, null, 2) + "\n");
  const summary = compactResult(result);
  const md = renderSummary(summary);
  await immutableWrite(summaryPath, md);
  return { ...summary, cacheHit, key, version, evidencePath, summaryPath,
    io: { pdfFilesRead: 0, seriesLoaded: library.packages.map(p => p.series) } };
}

function rounded(v) { return typeof v === "number" ? Number(v.toPrecision(6)) : v; }
function range(values) { return values.length ? [rounded(Math.min(...values)), rounded(Math.max(...values))] : null; }
export function selectCapacityShortlist(result) {
  const filter = result.normalized.candidateFilter;
  const unresolved = ['series', 'characteristic', 'size', 'trimFamily', 'flowDirection', 'rating'].filter(k => !filter[k]);
  const ready = Boolean(result.normalized.curveIds?.length) || Boolean(filter.series && filter.characteristic);
  const maximum = Math.max(0, ...result.cases.flatMap(c => c.requiredCvRange ?? []));
  const groups = new Map();
  for (const c of result.candidates) {
    // Merge only identical configurations AND calculated behaviour; different trims/curves remain separate.
    const key = digest([c.series,c.size,c.rating,c.characteristic,c.trimFamily,c.flowDirection,c.orifice,c.travel,c.ratedCv,c.review,c.scenarios]);
    if (groups.has(key)) groups.get(key).equivalentIds.push(c.id);
    else groups.set(key, {...c, equivalentIds:[c.id]});
  }
  const covers = c => maximum > 0 && c.ratedCv >= maximum;
  const ordered = [...groups.values()].sort((a,b) => Number(covers(b))-Number(covers(a))
    || (covers(a) && covers(b) ? a.ratedCv-b.ratedCv : 0));
  const candidates = ready ? ordered.slice(0,3) : [];
  const history = ready ? (result.historicalCandidates ?? []).filter(c => c.manualCoverage !== 'same-capacity-row' && c.status!=='HISTORICAL_CAPACITY_SHORTFALL').slice(0,3-candidates.length) : [];
  return { candidates, history, configuration: {status:ready?'CAPACITY_SCREENING':'CONFIGURATION_REQUIRED',
    filter, curveIds:result.normalized.curveIds, unresolved, meaning:'未指定的字段保持待定；容量预选不代表完整配置已确认。'} };
}

function compactResult(result) {
  const counts = {};
  for (const c of result.candidates) counts[c.status] = (counts[c.status] ?? 0) + 1;
  const selected = selectCapacityShortlist(result);
  return {
    status: result.status, liveValidated: false, businessGatePass: false,
    cases: result.cases.map(c => ({ name: c.name, status: c.status, choked: c.results.some(r=>r.choked), requiredCvRange: c.requiredCvRange?.map(rounded) ?? null })),
    configuration: selected.configuration,
    dropdownSelection: result.dropdownSelection ? {id:result.dropdownSelection.id,configuration:result.dropdownSelection.configuration,optionCount:result.dropdownSelection.optionCount,ratedCvValues:result.dropdownSelection.ratedCvValues,completeness:result.dropdownSelection.completeness,currentAvailabilityVerified:false} : null,
    candidateCount: result.candidates.length, candidateStatuses: counts,
    candidates: selected.candidates.map(c => ({
      equivalentIds: c.equivalentIds,
      id: c.id, series: c.series, size: c.size, rating: c.rating, characteristic: c.characteristic, trimFamily: c.trimFamily,
      flowDirection: c.flowDirection, ratedCv: c.ratedCv, status: c.status, review: c.review, source: c.source,
      coefficientBasis: [...new Set(c.scenarios.map(s => s.coefficientBasis))],
      scenarioCount: c.scenarios.length,
      cases: result.cases.map(({ name }) => {
        const points = c.scenarios.flatMap(s => s.cases.filter(p => p.name === name));
        return { name, statuses: [...new Set(points.map(p => p.status))],
          travelRangePercent: range(points.map(p => p.travelPercent).filter(Number.isFinite)),
          requiredCvRange: range(points.map(p => p.requiredCv).filter(Number.isFinite)),
          estimatedScenarios: points.filter(p => p.status === "ESTIMATED").length };
      }),
    })),
    historicalCandidateCount: result.historicalCandidates?.length ?? 0,
    historicalSupplement: selected.history.map(c => ({
      id: c.id, series: c.series, size: c.size, ratedCv: c.ratedCv, characteristic: c.characteristic,
      trimType: c.trimType, seatType: c.seatType, plugType: c.plugType, rating: c.rating, flowDirection: c.flowDirection,
      sourceKind: c.sourceKind, manualCoverage: c.manualCoverage, status: c.status, requiredCvMax: rounded(c.requiredCvMax),
      openingStatus: c.openingStatus, unresolvedFilterFields: c.unresolvedFilterFields,
      evidence: c.evidence[0], currentAvailabilityVerified: false })),
    limitations: result.limitations,
    omitted: ["full normalized input", "remaining candidate rows", "individual sensitivity scenarios, table context and coefficient arrays; see evidencePath"],
  };
}

function renderSummary(s) {
  const n = v => Number(v.toPrecision(3));
  const span = values => values ? [...new Set(values.map(n))].join('–') : '待定';
  const names = {series:'系列',characteristic:'特性',size:'口径',trimFamily:'内件',flowDirection:'流向',rating:'等级'};
  const values = {'equal-percentage':'等百分比',linear:'线性'};
  const filter = s.configuration.filter;
  const visible = Object.entries(filter).filter(([k])=>k in names);
  const lines = ['# 本地初算', '',
    `条件：${visible.map(([k,v])=>`${names[k]??k}=${values[v]??v}`).join('，') || '待定'}。`,
    `需求Cv：${s.cases.map(c=>`${c.name} ${span(c.requiredCvRange)}`).join('；')}。`, ''];
  if(s.dropdownSelection) lines.push(`已绑定历史完整下拉框，共${s.dropdownSelection.optionCount}档：${s.dropdownSelection.ratedCvValues.join('、')}。`);
  else lines.push('未绑定完整软件下拉框；以下手册候选不代表软件完整可选范围。');
  if (s.configuration.status==='CONFIGURATION_REQUIRED') lines.push('先明确系列和流量特性，再列容量候选；不默认等百分比。');
  else {
    lines.push('| 来源 | 口径 / 特性 / 等级 | 额定Cv | 各工况预计开度 |','|---|---|---:|---|');
    for (const c of s.candidates) lines.push(`| 手册 | ${c.size}in / ${values[c.characteristic]??c.characteristic} / ${c.rating} | ${c.ratedCv} | ${c.cases.map(p=>`${p.name} ${span(p.travelRangePercent)}${p.travelRangePercent?'%':''}`).join('；')} |`);
    for (const c of s.historicalSupplement) lines.push(`| 软件下拉框 | ${c.size}in / ${values[c.characteristic]??c.characteristic} / ${c.rating} | ${c.ratedCv} | 未知（${c.status==='HISTORICAL_CAPACITY_CANDIDATE'?'容量备选':'待核对'}） |`);
    if (!s.candidates.length && !s.historicalSupplement.length) lines.push('当前条件无匹配候选。');
  }
  if (s.cases.some(c=>c.status==='SPECIALIST_REVIEW')) lines.push('存在特殊流态，仅保留容量估算，需专项复核。');
  else if (s.cases.some(c=>c.choked)) lines.push('存在阻塞流，容量覆盖不代表噪声/速度通过。');
  const maximum = Math.max(0,...s.cases.flatMap(c=>c.requiredCvRange??[]));
  if (s.candidates.some(c=>maximum>c.ratedCv)) lines.push('有档位容量不足，不能直接选用。');
  // shortcut: 90% is a display hint only, not a customer acceptance limit; explicit windows remain in detailed results.
  if (s.candidates.some(c=>c.cases.some(p=>p.travelRangePercent?.[1]>=90))) lines.push('有档位接近全开，可对照更大一档；不据此直接淘汰。');
  if (s.candidates.some(c=>c.status!=='PRIORITY_FOR_SOFTWARE_CHECK')) lines.push('有开度、范围或曲线待核对项，详见同名JSON；小偏差不直接淘汰容量候选。');
  if (s.configuration.unresolved.length) lines.push(`待定：${s.configuration.unresolved.map(k=>names[k]).join('、')}。`);
  if (s.historicalSupplement.length) lines.push('软件下拉框选项的开度映射未核验，当前开度未知。');
  lines.push('仅容量初选；实际配置、供货、噪声和速度仍须软件核对。','');
  return lines.join('\n');
}

async function main(argv) {
  const [command, arg, ...rest] = argv;
  if (command === "inventory") {
    const index = await json(join(DATA, "index.json"));
    return { sources: index.sources.length, series: index.series, history: index.history ?? null, dropdowns:index.dropdowns??null, interpretation: index.interpretation };
  }
  if(command==='dropdowns'){
    const query=arg?await json(resolve(arg)):{};
    const {dropdowns}=await loadCapacityLibrary(query.series);
    const groups=dropdowns.filter(g=>Object.entries(query).every(([k,v])=>g.configuration[k]===v));
    return {count:groups.length,groups,usage:'选定完整配置组后，将其id作为preSizing.dropdownId；不会从历史选中值补档位。'};
  }
  if (command === 'capacity-directory') return buildCapacityDirectory(await loadCapacityLibrary(arg));
  if (command === "curve") {
    if (/^history-\d{5}-[a-f0-9]{12}$/.test(arg ?? '')) {
      const { history } = await loadCapacityLibrary(arg.split('-')[1]);
      const record = history.find(r => r.id === arg);
      if (!record) throw new PreSizingError('historical candidate not found');
      return record;
    }
    if (!/^\d{5}-p\d+-t\d+-r\d+$/.test(arg ?? "")) throw new PreSizingError("exact curve ID required");
    const { packages } = await loadCapacityLibrary(arg.slice(0, 5));
    for (const t of packages[0].tables) {
      const c = t.curves.find(c => c.id === arg);
      if (c) return { source: packages[0].source, pdfPage: t.pdfPage, tableContext: t.context,
        travelPercent: t.travelPercent, factorRows: t.factorRows, tableReview: t.review, curve: c };
    }
    throw new PreSizingError("curve not found");
  }
  if (command === "catalog") {
    const query = await json(resolve(arg));
    const { packages, dropdowns } = await loadCapacityLibrary(query.series);
    for (const k of Object.keys(query)) if (!["series", "size", "rating", "characteristic", "flowDirection", "tableId", "trimFamily"].includes(k)) throw new PreSizingError(`unknown filter: ${k}`);
    const rows = packages.flatMap(p => p.tables.flatMap(t => t.curves.map(c => ({ series: p.series, ...c, review: [...t.review, ...c.review] }))))
      .filter(c => Object.entries(query).every(([k, v]) => k === "size" ? catalogSizeMatches(c.size, v) : c[k] === v))
      .map(({ id, series, size, rating, characteristic, flowDirection, trimFamily, ratedCv, review }) => ({ id, series, size, rating, characteristic, flowDirection, trimFamily, ratedCv, review }));
    return { count: rows.length, rows: rows.slice(0, 20), truncated: rows.length > 20,
      dropdowns:dropdowns.filter(g=>Object.entries(query).every(([k,v])=>g.configuration[k]===v)),
      historicalCount:0,historicalRows:[],historicalTruncated:false,
      limitations: packages.flatMap(p => p.limitations), next: 'dropdowns FILTER.json returns complete software option sets; historical selected values are not options' };
  }

  if (command === "calculate") {
    const options = {};
    for (let i = 0; i < rest.length; i += 2) {
      if (!["--out-dir", "--cache-dir"].includes(rest[i]) || !rest[i + 1]) throw new PreSizingError("use --out-dir PATH [--cache-dir PATH]");
      options[rest[i] === "--out-dir" ? "outDir" : "cacheDir"] = resolve(rest[i + 1]);
    }
    if (!options.outDir) throw new PreSizingError("--out-dir is required");
    return runPreSizing(await json(resolve(arg)), options);
  }
  throw new PreSizingError("usage: pre-sizing-cli.mjs inventory | capacity-directory [SERIES] | dropdowns [FILTER.json] | catalog FILTER.json | curve ID | calculate INPUT.json --out-dir DIR [--cache-dir DIR]");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(r => console.log(JSON.stringify(r, null, 2))).catch(e => { console.error(e.message); process.exitCode = 1; });
}
