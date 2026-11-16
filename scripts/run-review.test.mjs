import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getReviewRecord } from './review-result.mjs';
import { runReview, verifyReviewResults } from './run-review.mjs';
const fixture=JSON.parse(await readFile(new URL('./fixtures/batch.json',import.meta.url),'utf8'));
const fresh=()=>structuredClone(fixture);
test('统一入口覆盖备查短行程，且备查不升级主展示',async()=>{
 const x=fresh(),before=JSON.stringify(x),r=await runReview(x);
 assert.deepEqual(r.coverage,{valves:1,candidates:2,sourceCases:1});
 assert.equal(r.valves[0].actuators.candidates.length,2);
 assert.deepEqual(r.valves[0].selectedSchemeIds,['body-short']);
 assert.equal(JSON.stringify(x),before);assert.equal(r.engineeringQualified,false);
 assert(r.sourceHashes['scripts/actuator-screen.mjs']);
 const comparison=r.valves[0].actuators.candidates[0].combinations.find(c=>c.review.comparisons.length).review.comparisons[0];
 assert.equal(comparison.baselineReferenceHeadroom.status,'BASELINE_REFERENCE_ONLY');
 assert.equal(comparison.baselineReferenceHeadroom.directions.open.headroomN,comparison.availableOpenN-comparison.baselineReferenceHeadroom.directions.open.adoptedDemandN);
});
test('拒绝重复位号、重复候选、自填输出力及失去取舍依据',async()=>{
 const x=fresh();x.valves.push(structuredClone(x.valves[0]));await assert.rejects(runReview(x),/唯一/);
 const y=fresh();y.valves[0].candidates[1].id=y.valves[0].candidates[0].id;await assert.rejects(runReview(y),/唯一/);
 const z=fresh();z.valves[0].candidates[0].check.actuatorReview={capacities:[]};await assert.rejects(runReview(z),/不接受/);
 const a=fresh();delete a.valves[0].candidates[0].decisionBasis;await assert.rejects(runReview(a),/取舍依据/);
});
test('缺少全工况计算必须明示，不能被候选伪造sourceCases掩盖',async()=>{
 const x=fresh();x.valves[0].sourceCases.push({name:'Min',massFlowKgH:100});
 const r=await runReview(x);assert.equal(r.valves[0].records[0].check.coverage.complete,false);
 assert(r.valves[0].records[0].check.coverage.omitted.includes('Min'));
});
test('CLI真实运行、拒绝覆盖、重算发现结果篡改',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'valve-review-'));
 try {const input=join(dir,'input.json'),output=join(dir,'result.json');await writeFile(input,JSON.stringify(fresh()));
 const cli=fileURLToPath(new URL('./run-review.mjs',import.meta.url));
 execFileSync(process.execPath,[cli,input,output]);
 assert.equal(JSON.parse(execFileSync(process.execPath,[cli,input,output,'--verify'])).reproduced,true);
 assert.throws(()=>execFileSync(process.execPath,[cli,input,output],{stdio:'pipe'}));
 const r=JSON.parse(await readFile(output,'utf8'));r.valves[0].selectedSchemeIds=[];await writeFile(output,JSON.stringify(r));
 assert.throws(()=>execFileSync(process.execPath,[cli,input,output,'--verify'],{stdio:'pipe'}));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('没有候选仍保留位号及原因，不能冒称已经完成枚举',async()=>{
 const x=fresh();x.valves[0].candidates=[];
 await assert.rejects(runReview(x),/无候选/);x.valves[0].noCandidateReason='待补原阀门配置';
 const r=await runReview(x);assert.equal(r.valves.length,1);assert.equal(r.valves[0].actuators.coverage.complete,false);
});
test('容量引擎实际调用，忽略外填Cv/开度且不遗漏源工况',async()=>{
 const here=new URL('../',import.meta.url);
 const paths=[new URL('runtime/tools/valvstream/fixtures/synthetic/pre-sizing-gas.json',here),new URL('../../../tools/valvstream/fixtures/synthetic/pre-sizing-gas.json',here)];
 let gas;for(const path of paths){try{gas=JSON.parse(await readFile(path,'utf8'));break;}catch{}}
 assert(gas);
 const x=fresh(),v=x.valves[0];v.capacityInput=gas;
 v.sourceCases=gas.sizing.cases.map(c=>({name:c.name,massFlowKgH:c.flow*c.properties.densityKgM3}));
 const {calculatePreSizing}=await import(new URL((await import('node:fs')).existsSync(new URL('runtime',here))?'runtime/tools/valvstream/pre-sizing.mjs':'../../../tools/valvstream/pre-sizing.mjs',here));
 const dataPaths=[new URL('runtime/.agents/skills/valvstream-selection/data/capacity/21000.json',here),new URL('../valvstream-selection/data/capacity/21000.json',here)];
 let pkg;for(const path of dataPaths){try{pkg=JSON.parse(await readFile(path,'utf8'));break;}catch{}}
 const curve=calculatePreSizing(gas,[pkg]).candidates.find(c=>c.scenarios.some(s=>s.cases.every(p=>p.status==='ESTIMATED'))&&/^\d+(\.\d+)?$/.test(c.travel));assert(curve);
 v.candidates=[v.candidates[0]];const c=v.candidates[0];c.curveId=curve.id;delete c.actuation.travelIn;
 c.check.cases=[{name:'Max',requiredCv:999999,estimatedTravelPercent:1}];
 const r=await runReview(x);const rec=r.valves[0].records[0];
 assert.equal(rec.check.input.candidate.ratedCv,curve.ratedCv);assert.equal(rec.check.coverage.complete,true);
 assert(rec.check.input.cases.every(p=>p.requiredCv!==999999));assert(r.valves[0].capacity.engineSha256);
 c.actuation.travelIn=999;await assert.rejects(runReview(x),/行程/);
 delete c.actuation.travelIn;v.capacityInput.sizing.cases[0].flow*=1000;v.sourceCases[0].massFlowKgH=v.capacityInput.sizing.cases[0].flow*v.capacityInput.sizing.cases[0].properties.densityKgM3;
 const insufficient=(await runReview(x)).valves[0].records[0];
 assert(insufficient.check.input.cases[0].requiredCv>insufficient.check.input.candidate.ratedCv);
 assert(insufficient.rejected.some(s=>s.includes('容量不足')));
});

test('明确新需求全部不足则排除；独立阀盖方向不被连带删除',async()=>{
 const x=fresh(),v=x.valves[0],c=v.candidates[0];
 c.actuation.candidateDemand={openN:40000,closeN:40000,safetyFactor:1.2,safetyFactorInclusion:'included',source:'synthetic new total'};
 v.candidates.push({id:'bonnet-only',kind:'special',route:'取消加长阀盖',upstreamPriority:'有条件候选',decisionBasis:'合成独立温度判断',specialAssessment:'合成标准阀盖温度适用；其他配置不变',actuation:{required:false,travelIn:2.5,loadChanged:false}});
 const r=await runReview(x);assert(!r.valves[0].selectedSchemeIds.includes(c.id));assert(r.valves[0].selectedSchemeIds.includes('bonnet-only'));
 assert(r.valves[0].records.find(y=>y.id===c.id).rejected.some(s=>s.includes('全部执行机构')));
});
test('选中不足组合时排除，但不把任一枚举失败等同全部失败',async()=>{
 const x=fresh(),v=x.valves[0],c=v.candidates[0];
 c.actuation.candidateDemand={openN:5000,closeN:5000,safetyFactor:1,safetyFactorInclusion:'included',source:'synthetic new total'};
 let r=await runReview(x);const opts=r.valves[0].actuators.candidates[0].combinations;
 const bad=opts.find(o=>o.review.comparisons.some(z=>z.candidateVerdict==='INSUFFICIENT'));
 const good=opts.find(o=>o.review.comparisons.every(z=>z.candidateVerdict==='MARGIN'));assert(bad&&good);
 assert(r.valves[0].selectedSchemeIds.includes(c.id));
 const pick=o=>({type:o.type,size:o.size,travelIn:o.travelIn,spring:o.spring});
 c.actuation.selection=pick(bad);r=await runReview(x);assert(!r.valves[0].selectedSchemeIds.includes(c.id));
 c.actuation.selection=pick(good);r=await runReview(x);assert(r.valves[0].selectedSchemeIds.includes(c.id));
 c.actuation.selection.size='unknown';await assert.rejects(runReview(x),/未匹配/);
});
test('旧需求不足不冒充新负荷失败；新负荷仍缺失',async()=>{
 const x=fresh();Object.assign(x.valves[0].actuator.baselineDemand,{openN:40000,closeN:40000});
 const r=await runReview(x);assert(r.valves[0].selectedSchemeIds.includes('body-short'));assert.equal(r.checks.newActuatorLoadsComplete,false);
});
test('流速参考、硬限值、未知限值和适用偏差接受走完整批量筛选',async()=>{
 const x=fresh(),c=x.valves[0].candidates[0].check.cases[0];c.velocityLimitMps=1;
 let r=await runReview(x);assert(r.valves[0].selectedSchemeIds.includes('body-short'));
 c.velocityLimitType='hard';r=await runReview(x);assert(!r.valves[0].selectedSchemeIds.includes('body-short'));
 c.velocityDeviationAcceptance={source:'synthetic explicit acceptance',limitMps:6};r=await runReview(x);assert(r.valves[0].selectedSchemeIds.includes('body-short'));
 c.velocityDeviationAcceptance.limitMps=5;r=await runReview(x);assert(!r.valves[0].selectedSchemeIds.includes('body-short'));
 delete c.velocityDeviationAcceptance;delete c.velocityLimitType;r=await runReview(x);assert(!r.valves[0].selectedSchemeIds.includes('body-short'));assert.equal(r.valves[0].records.find(z=>z.id==='body-short').rejected.length,0);
});
test('v2结果只存一次机构计算，读回恢复；缺引用报错',async()=>{
 const r=await runReview(fresh()),v=r.valves[0],record=v.records[0];
 assert.equal(r.schemaVersion,2);assert.equal(record.actuatorScreen,undefined);assert.equal(record.check.curve,undefined);
 assert.deepEqual(getReviewRecord(v,record.id).actuatorScreen,v.actuators.candidates.find(c=>c.id===record.id));
 const old=structuredClone(v);old.records=old.records.map(c=>getReviewRecord(v,c.id));for(const c of old.records){delete c.actuatorRef;delete c.check.curveRef;}
 assert.deepEqual(getReviewRecord(old,record.id).actuatorScreen,getReviewRecord(v,record.id).actuatorScreen);
 v.actuators.candidates=[];assert.throws(()=>getReviewRecord(v,record.id),/引用缺失/);
});
test('仅Skill文字版本变化提示复读规则；数值、采用方案或计算文件变化仍拒绝',async()=>{
 const r=await runReview(fresh()),old=structuredClone(r);old.sourceHashes['SKILL.md']='0'.repeat(64);
 assert.deepEqual(verifyReviewResults(r,old),{reproduced:true,ruleVersionChanged:true,ruleReviewRequired:true});
 old.sourceHashes['scripts/check-candidate.mjs']='other-engine';assert.throws(()=>verifyReviewResults(r,old),/不一致/);
});

test('供气不足弹簧端点的负输出也不能作为已知新负荷推荐',async()=>{
 const x=fresh();x.valves[0].actuator.minimumSupplyMPa=0.02;
 x.valves[0].candidates[0].actuation.candidateDemand={openN:100,closeN:100,safetyFactor:1,safetyFactorInclusion:'included',source:'synthetic new demand'};
 assert(!(await runReview(x)).valves[0].selectedSchemeIds.includes('body-short'));
});

test('特殊方案未明确受力范围时只保留待核，不能绕过机构检查',async()=>{
 const x=fresh();x.valves[0].candidates=[{id:'special',kind:'special',route:'独立配置',upstreamPriority:'有条件候选',decisionBasis:'synthetic',specialAssessment:'synthetic',actuation:{travelIn:2.5,loadChanged:false}}];
 const r=await runReview(x);assert.deepEqual(r.valves[0].selectedSchemeIds,[]);assert.match(r.valves[0].records[0].notPreparedReason,/required/);assert.deepEqual(r.valves[0].records[0].rejected,[]);
});
