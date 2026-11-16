import test from 'node:test';
import assert from 'node:assert/strict';
import {selectSchemes} from './select-schemes.mjs';
const plan=(id,extra={})=>({id,kind:'capacity',status:'有条件候选',upstreamPriority:'有条件候选',route:'同口径减Cv',benefitClass:'physical',evidenceClass:'curve',riskClass:'pending',...extra});
test('备查和已知失败不得升级为主展示，优先复核不被覆盖',()=>{
 const got=selectSchemes([plan('archive',{upstreamPriority:'不建议优先试选；保留计算备查'}),plan('failed',{rejected:['最低气源不足']}),plan('priority',{status:'优先复核',upstreamPriority:'优先复核'})]);
 assert.deepEqual(got.selectedSchemeIds,['priority']); assert.equal(got.records.find(s=>s.id==='archive').status,'不建议优先试选；保留计算备查');
});
test('打乱输入不改变取舍；独立特殊方向参加比较后再限制展示数',()=>{
 const input=[plan('a'),plan('b'),plan('c'),plan('special',{kind:'special',route:'标准阀盖',benefitClass:'physical',evidenceClass:'concept'})];
 const a=selectSchemes(input),b=selectSchemes([...input].reverse());assert.deepEqual(a.selectedSchemeIds,b.selectedSchemeIds);assert(a.selectedSchemeIds.includes('special')); assert(a.records.filter(s=>!s.display.selected).every(s=>s.display.reason));
});
test('缺数据不默认为0，不拒绝其余方案；空输入可返回',()=>{
 const got=selectSchemes([plan('missing',{evidenceClass:undefined,riskClass:undefined}),plan('known',{upstreamPriority:'优先复核'})]);assert(got.selectedSchemeIds.includes('known'));assert.equal(got.records.find(s=>s.id==='missing').selectionBasis?.evidence,'unknown'); assert.deepEqual(selectSchemes([]).selectedSchemeIds,[]);
});
test('保留原正确的硬排除和正常候选，纯函数不修改输入',()=>{
 const input=[plan('good'),plan('no',{rejected:['不满足半管径']})],before=JSON.stringify(input);const got=selectSchemes(input);assert.deepEqual(got.selectedSchemeIds,['good']);assert.equal(JSON.stringify(input),before);assert.equal(got.records.length,2);
});
test('无位号专门分支，标签变化不改变方案取舍',()=>{
 const input=[plan('x',{item:'3'}),plan('y',{item:'112',upstreamPriority:'优先复核'})];assert.deepEqual(selectSchemes(input).selectedSchemeIds,selectSchemes(input.map(s=>({...s,item:'random'}))).selectedSchemeIds);
});
test('组合失败不连带排除独立成立的阀盖和参数待补的有据异径方向',()=>{
 const got=selectSchemes([plan('combined',{route:'阀盖＋机构',rejected:['机构供气不足']}),plan('bonnet',{kind:'special',route:'取消加长阀盖'}),plan('asymmetric',{kind:'special',route:'异径结构',evidenceClass:'concept',pending:['容量曲线待补，已有设计方向依据']})]);
 assert.deepEqual(new Set(got.selectedSchemeIds),new Set(['bonnet','asymmetric']));
});
