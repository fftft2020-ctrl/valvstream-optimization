import test from 'node:test';
import assert from 'node:assert/strict';
import {reportFixture} from '../fixtures/report.mjs';
import {buildReportModel,reportStrategies} from './report-model.mjs';
const strategies=await reportStrategies();
test('三种改动只显示受影响内容，采用计算记录并保留原单位和全部工况',async()=>{
  const {result,plan}=await reportFixture();const before=JSON.stringify(result),m=buildReportModel(result,plan,strategies);
  assert.equal(m.schemes.length,3);assert.equal(m.strategies.length,12);
  assert.equal(m.schemes[0].operatingCases.length,3);assert.equal(m.schemes[0].operatingCases[0].pressureUnit,'MPa a');
  assert.equal(m.schemes[0].operatingCases[0].optimizedRequiredCv,25);
  assert.equal(m.schemes[0].demandHeader,'优化方案（假设上限）');
  assert.equal(m.schemes[1].operatingCases.length+m.schemes[1].demandRows.length+m.schemes[1].actuatorRows.length,0);
  assert.equal(m.schemes[2].demandRows[0].original,m.schemes[2].demandRows[0].optimized);
  assert(m.schemes[2].actuatorRows.some(r=>r.label==='关闭输出'&&r.unit==='lbf'));
  assert.equal(JSON.stringify(result),before);
});
test('拒绝过期计划、失败方案、漏工况、纯CV改动与擅自更换机构',async()=>{
  const {result,plan}=await reportFixture();
  for(const change of [p=>p.inputSha256='wrong',p=>p.schemes[0].originalCases.pop(),p=>p.schemes[0].selectedActuator.size='23',p=>p.schemes[0].configurationRows=p.schemes[0].configurationRows.filter(r=>['型号','额定CV'].includes(r.label))]){
    const p=structuredClone(plan);change(p);assert.throws(()=>buildReportModel(result,p,strategies));
  }
  result.valves[0].selectedSchemeIds=[];assert.throws(()=>buildReportModel(result,plan,strategies),/可展示/);
});
test('缺新需求不自动显示假设，空汇总可生成',async()=>{
  const {result,plan}=await reportFixture();delete plan.schemes[0].demandAssumption;
  assert.equal(buildReportModel(result,plan,strategies).schemes[0].demandRows[0].optimized,'待核');
  plan.schemes=[];assert.equal(buildReportModel(result,plan,strategies).schemes.length,0);
});
