// Synthetic examples only; no customer configuration, assumption or limit is a default.
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {runReview} from '../run-review.mjs';
export async function reportFixture() {
  const base=JSON.parse(await readFile(new URL('./batch.json',import.meta.url),'utf8'));
  const capacity=base.valves[0];capacity.candidates=capacity.candidates.slice(0,1);
  const candidate=capacity.candidates[0];
  const choice={type:'88',size:'16',travelIn:2,spring:[11,23]};
  candidate.actuation.selection=choice;
  capacity.sourceCases=[{name:'Max',massFlowKgH:36000},{name:'Norm',massFlowKgH:18000},{name:'Min',massFlowKgH:3600}];
  candidate.check.cases=capacity.sourceCases.map((s,i)=>({...candidate.check.cases[0],...s,requiredCv:[25,12.5,2.5][i],estimatedTravelPercent:[75,55,22][i]}));
  const bonnet=structuredClone(capacity);bonnet.id='SYNTHETIC-2';bonnet.candidates=[{id:'bonnet',kind:'special',route:'取消加长阀盖',upstreamPriority:'有条件候选',decisionBasis:'合成温度范围示例',specialAssessment:'合成资料：标准阀盖覆盖设计温度',actuation:{required:false,travelIn:2.5,loadChanged:false}}];
  const actuator=structuredClone(bonnet);actuator.id='SYNTHETIC-3';actuator.candidates=[{id:'actuator',kind:'special',route:'缩执行机构',upstreamPriority:'有条件候选',decisionBasis:'合成原需求对照',specialAssessment:'阀门配置未变',actuation:{required:true,travelIn:2.5,loadChanged:false,selection:{...choice,travelIn:2.5}}}];
  const input={schemaVersion:1,valves:[capacity,bonnet,actuator]};
  const result=await runReview(input),bytes=JSON.stringify(result,null,2)+'\n';
  const modelRow={label:'型号',kind:'text',original:'SYNTHETIC-MODEL',optimized:'SYNTHETIC-MODEL'};
  const actuatorRow={label:'执行机构',kind:'text',original:'88系列，23号',optimized:'88系列，16号'};
  const plan={schemaVersion:1,inputSha256:result.inputSha256,resultSha256:createHash('sha256').update(bytes).digest('hex'),schemes:[
    {valveId:capacity.id,candidateId:candidate.id,schemeId:'TEST-01',originalSizeIn:3,quantity:1,scope:'capacity',strategyIds:['1.1','3.3'],benefit:'缩小阀体和执行机构。',reason:'合成示例：较小阀体覆盖三个工况。',selectedActuator:choice,demandAssumption:{kind:'not-increased',source:'合成授权；不是客户假设'},configurationRows:[modelRow,{label:'尺寸',kind:'text',unit:'in',original:'3×3×3',optimized:'2×2×2'},{label:'额定CV',kind:'cv',original:65,optimized:46},actuatorRow,{label:'行程',kind:'length',unit:'in',original:2.5,optimized:2}],originalCases:capacity.sourceCases.map((c,i)=>({name:c.name,flowValue:c.massFlowKgH,flowUnit:'kg/h',p1:1.5,p2:1,pressureUnit:'MPa a',temperatureC:[100,110,120][i],originalRequiredCv:[25,12.5,2.5][i],originalOpeningPercent:[50,35,15][i],originalOutletVelocityMps:[1.989436788648692,0.994718394324346,0.1989436788648692][i]}))},
    {valveId:bonnet.id,candidateId:'bonnet',schemeId:'TEST-02',originalSizeIn:3,quantity:2,scope:'bonnet-only',strategyIds:['案例16'],benefit:'取消加长阀盖。',reason:'合成示例：设计温度100°C在标准阀盖适用范围内。',configurationRows:[modelRow,{label:'阀盖',kind:'text',original:'加长阀盖',optimized:'标准阀盖'}]},
    {valveId:actuator.id,candidateId:'actuator',schemeId:'TEST-03',originalSizeIn:3,quantity:1,scope:'actuator',strategyIds:['3.1'],benefit:'缩小执行机构。',reason:'合成示例：较小机构覆盖原开启、关闭需求。',selectedActuator:{...choice,travelIn:2.5},configurationRows:[modelRow,actuatorRow,{label:'弹簧',kind:'text',unit:'psi',original:'21–45',optimized:'11–23'}]}
  ]};
  return {input,result,bytes,plan};
}
