#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

// v2 stores curves and actuator calculations once; frozen v1 reports remain readable.
export function getReviewRecord(valve, id) {
  const record = valve.records.find(r => r.id === id);
  if (!record) throw new Error('未找到方案：' + id);
  const curve = record.check.curve ?? (record.check.curveRef ? valve.capacity?.result.candidates.find(c => c.id === record.check.curveRef) : null);
  const actuatorScreen = record.actuatorScreen ?? (record.actuatorRef ? valve.actuators.candidates.find(c => c.id === record.actuatorRef) : null);
  if (record.check.curveRef && !curve || record.actuatorRef && !actuatorScreen) throw new Error('计算记录引用缺失：' + id);
  return {...record,check:{...record.check,curve:curve ?? null},actuatorScreen:actuatorScreen ?? null};
}

export function summarizeReview(result) {
  return {schemaVersion:result.schemaVersion,coverage:result.coverage,checks:result.checks,engineeringQualified:false,
    valves:result.valves.map(v => ({id:v.id,selectedSchemeIds:v.selectedSchemeIds,
      schemes:v.records.map(r => ({id:r.id,selected:r.display.selected,status:r.status,
        rejected:r.rejected,hold:r.notPreparedReason ?? null,missing:r.check.missing,deviations:r.check.deviations ?? []}))}))};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!process.argv[2] || process.argv.length > 4) throw new Error('Usage: node review-result.mjs result.json [valveId]');
    const result = JSON.parse(await readFile(process.argv[2],'utf8'));
    if (![1,2].includes(result.schemaVersion)) throw new Error('不支持的计算结果版本');
    if (process.argv[3]) {
      const valve = result.valves.find(v => v.id === process.argv[3]);
      if (!valve) throw new Error('未找到位号');
      console.log(JSON.stringify({...valve,records:valve.records.map(r => getReviewRecord(valve,r.id))},null,2));
    } else console.log(JSON.stringify(summarizeReview(result),null,2));
  } catch(e) {console.error(e.message);process.exitCode=1;}
}
