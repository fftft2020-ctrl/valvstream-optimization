import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkCandidate } from './check-candidate.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/candidate.json', import.meta.url), 'utf8'));
const sample = () => structuredClone(fixture);
test('half-pipe is inclusive; DN40 on DN100 is rejected before recommendation', () => {
  const x = sample(); assert.equal(checkCandidate(x).status, 'READY_FOR_SOFTWARE_CHECK');
  x.candidate.bodyNominalMm = 40; assert.equal(checkCandidate(x).status, 'REJECTED');
});
test('both pipe ends matter and unknown pipe size does not pass', () => {
  const x = sample(); x.pipeNominalMm.outlet = 150; assert.equal(checkCandidate(x).status, 'REJECTED');
  delete x.pipeNominalMm.outlet; assert.equal(checkCandidate(x).status, 'NEEDS_DATA');
});
test('packing feature change and material change are both rejected', () => {
  for (const packing of [{ material: 'Graphite', features: ['original'] }, { material: 'PTFE', features: [] }]) {
    const x = sample(); x.candidate.packing = packing; assert.equal(checkCandidate(x).status, 'REJECTED');
  }
});
test('fixed-body Cv route cannot silently change body or increase Cv', () => {
  const x = sample(); x.direction = 'cv'; assert.equal(checkCandidate(x).status, 'REJECTED');
  x.candidate.bodyNominalMm = 80; assert.equal(checkCandidate(x).status, 'READY_FOR_SOFTWARE_CHECK');
  x.candidate.ratedCv = 65; assert.equal(checkCandidate(x).status, 'REJECTED');
});
test('all cases checked, not only the final case', () => {
  const x = sample(); x.sourceCases.unshift({...x.sourceCases[0],name:'OtherLoad'}); x.cases.unshift({ ...x.cases[0], name: 'OtherLoad', requiredCv: 50 });
  assert.equal(checkCandidate(x).status, 'REJECTED');
});
test('noise overage is a deviation, never full approval', () => {
  const x = sample(); Object.assign(x.cases[0],{noiseDbA:90,noiseRelation:'=',noiseBasis:'prediction'});
  const r = checkCandidate(x); assert.equal(r.status, 'DEVIATION_REVIEW');
  assert.match(r.deviations[0], /5 dB/); assert.equal(r.liveValidated, false); assert.equal(r.businessGatePass, false);
});
test('same flow, density, outlet bore: lowering Cv does not lower outlet velocity', () => {
  const x = sample(), first = checkCandidate(x).cases[0].velocityMps;
  x.candidate.ratedCv = 35; assert.equal(checkCandidate(x).cases[0].velocityMps, first);
  x.cases[0].outletDiameterMm = 25;
  const r = checkCandidate(x); assert.ok(Math.abs(r.cases[0].velocityMps / first - 4) < 1e-12);
  assert.equal(r.status, 'DEVIATION_REVIEW');
});
test('zero flow is not replaced with fake positive flow', () => {
  const x = sample(); x.sourceCases[0].massFlowKgH=0; Object.assign(x.cases[0], { massFlowKgH: 0, requiredCv: 0, estimatedTravelPercent: null });
  const r = checkCandidate(x); assert.equal(r.cases[0].velocityMps, 0); assert.equal(r.status, 'READY_FOR_SOFTWARE_CHECK');
});
test('missing evidence, null cases, strings and non-finite numbers cannot silently pass', () => {
  for (const change of [x => x.evidence = [], x => x.cases = [null], x => x.cases[0].requiredCv = '25',
    x => x.cases[0].outletDiameterMm = Infinity, x => x.baseline.packing = null, x => x.pipeNominalMm = null]) {
    const x = sample(); change(x); assert.equal(checkCandidate(x).status, 'NEEDS_DATA');
  }
});
test('hydraulic lower bound rejects insufficient force; sufficient bound is not full sizing', () => {
  const x = sample(); x.forceScreen = { shutoffMPa: 14, netPressureAreaMm2: 800, availableClosingN: 10000 };
  let r = checkCandidate(x); assert.equal(r.hydraulicClosingLowerBoundN, 11200); assert.equal(r.status, 'REJECTED');
  x.forceScreen.availableClosingN = 13000; r = checkCandidate(x);
  assert.equal(r.status, 'READY_FOR_SOFTWARE_CHECK'); assert.ok(r.pending.some(v => v.includes('开启方向')));
});
test('90 percent is a comparison trigger; 100 percent is rejected', () => {
  const x = sample(); x.cases[0].estimatedTravelPercent = 92;
  assert.equal(checkCandidate(x).status, 'READY_FOR_SOFTWARE_CHECK');
  x.cases[0].estimatedTravelPercent = 100; assert.equal(checkCandidate(x).status, 'REJECTED');
});

test('missing a source condition is visible even when every supplied result is good', () => {
  const x=sample();x.sourceCases.push({name:'Min',massFlowKgH:900});
  const r=checkCandidate(x);assert.equal(r.status,'NEEDS_DATA');assert.equal(r.coverage.complete,false);assert.deepEqual(r.coverage.omitted,['Min']);
});
test('missing zero-flow source case is not silently omitted', () => {
  const x=sample();x.sourceCases.push({name:'Shut',massFlowKgH:0});
  assert.deepEqual(checkCandidate(x).coverage.omitted,['Shut']);
  x.cases.push({name:'Shut',massFlowKgH:0,requiredCv:0,estimatedTravelPercent:null});
  const r=checkCandidate(x);assert.equal(r.coverage.complete,true);assert.equal(r.cases[1].velocityMps,0);
});
test('bad source names, duplicate results, unexpected conditions and altered flow fail safely', () => {
  for(const sourceCases of [null,[],[null],[{name:'Max',massFlowKgH:'36000'}],[{name:'Max',massFlowKgH:36000},{name:'Max',massFlowKgH:36000}]]){
    const x=sample();x.sourceCases=sourceCases;const r=checkCandidate(x);assert.equal(r.coverage.complete,false);assert.equal(r.status,'NEEDS_DATA');
  }
  const x=sample();x.cases.push({...x.cases[0]});assert.equal(checkCandidate(x).coverage.complete,false);
  x.cases[1].name='Unexpected';assert.equal(checkCandidate(x).status,'REJECTED');
  x.cases.pop();x.cases[0].massFlowKgH=100;const r=checkCandidate(x);assert.equal(r.status,'REJECTED');assert.equal(r.coverage.complete,false);
});
test('legacy inputs still parse but never silently claim coverage or independent evidence', () => {
  const x=sample();delete x.sourceCases;delete x.calculationBasis;delete x.cases[0].outletAreaBasis;delete x.cases[0].outletDensityBasis;
  const r=checkCandidate(x);assert.equal(r.status,'NEEDS_DATA');assert.equal(r.coverage.complete,false);assert.equal(r.calculationBasis,'unknown');
  assert.equal(r.cases[0].velocityMps,null);assert(r.cases[0].roughVelocityMps>0);
});
test('adopted specification inputs are allowed; the calculator does not insist on a customer-sheet-only origin', () => {
  const x=sample();x.evidence=['synthetic-specification-page.json','synthetic-case-extraction.json'];
  assert.equal(checkCandidate(x).status,'READY_FOR_SOFTWARE_CHECK');
});
test('calibrated xT estimate remains an estimate and requires explicit assumptions', () => {
  const x=sample();x.calculationBasis={type:'estimate',description:'Synthetic inverse fit'};
  assert.equal(checkCandidate(x).status,'NEEDS_DATA');
  x.calculationBasis.assumptions=['Fp=1; candidate xT assumed from baseline; sensitivity scenario only'];
  const r=checkCandidate(x);assert.equal(r.status,'READY_FOR_SOFTWARE_CHECK');assert.equal(r.calculationBasis,'estimate');assert.equal(r.liveValidated,false);assert.equal(r.businessGatePass,false);
  x.calculationBasis.type='reference';assert.equal(checkCandidate(x).status,'NEEDS_DATA');
});
test('invalid basis types and empty descriptions do not pass', () => {
  for(const basis of [null,{}, {type:'independent'}, {type:'random',description:'x'}, {type:'estimate',description:'x',assumptions:[]}]){
    const x=sample();x.calculationBasis=basis;assert.equal(checkCandidate(x).status,'NEEDS_DATA');
  }
});
test('nominal area or assumed outlet density is a rough estimate, not actual velocity acceptance', () => {
  for(const patch of [{outletAreaBasis:'nominal'},{outletDensityBasis:'assumed'}]){
    const x=sample();Object.assign(x.cases[0],patch,{velocityAssumptions:'Synthetic nominal area or outlet density assumption'});
    const r=checkCandidate(x);assert.equal(r.status,'NEEDS_DATA');assert.equal(r.cases[0].velocityMps,null);assert(r.cases[0].roughVelocityMps>0);
  }
});
test('source-matched flow does not establish density applicability across different states', () => {
  const x=sample();x.cases[0].outletDensityBasis='assumed';x.cases[0].velocityAssumptions='Normal density copied to Max without matching temperature';
  assert.equal(checkCandidate(x).status,'NEEDS_DATA');
});
test('source noise including less-than values is not a new candidate prediction', () => {
  const x=sample();Object.assign(x.cases[0],{noiseDbA:70,noiseRelation:'<',noiseBasis:'original-report'});
  const r=checkCandidate(x);assert.equal(r.cases[0].newNoiseDbA,null);assert.equal(r.cases[0].noiseAssessment,'NOT_PREDICTED');
  assert(r.pending.some(s=>s.includes('原报告噪声只作基准')));assert.equal(x.cases[0].noiseRelation,'<');
});
test('a numeric noise field without origin and relation cannot be promoted to a new prediction', () => {
  const x=sample();x.cases[0].noiseDbA=70;const r=checkCandidate(x);assert.equal(r.status,'NEEDS_DATA');assert.equal(r.cases[0].newNoiseDbA,null);
});
test('strict noise limit distinguishes equality from inclusive limit', () => {
  const x=sample();Object.assign(x.cases[0],{noiseDbA:85,noiseRelation:'=',noiseBasis:'prediction',noiseLimitRelation:'<'});
  let r=checkCandidate(x);assert.equal(r.status,'DEVIATION_REVIEW');assert.equal(r.cases[0].noiseDifferenceDb,0);
  x.cases[0].noiseLimitRelation='<=';r=checkCandidate(x);assert.equal(r.cases[0].noiseAssessment,'WITHIN_LIMIT');
  delete x.cases[0].noiseLimitRelation;assert.equal(checkCandidate(x).status,'NEEDS_DATA');
});
test('noise bounds preserve uncertainty and do not invent a precise decibel difference', () => {
  for(const [value,relation,limitRelation,expected] of [[70,'<','<','WITHIN_LIMIT'],[85,'<','<','WITHIN_LIMIT'],[85,'<=','<','INDETERMINATE'],[90,'<','<=','INDETERMINATE'],[85,'>','<=','EXCEEDS_LIMIT'],[85,'>=','<','EXCEEDS_LIMIT'],[85,'>=','<=','INDETERMINATE']]){
    const x=sample();Object.assign(x.cases[0],{noiseDbA:value,noiseRelation:relation,noiseBasis:'prediction',noiseLimitRelation:limitRelation});
    const r=checkCandidate(x);assert.equal(r.cases[0].noiseAssessment,expected);assert.equal(r.cases[0].noiseDifferenceDb,null);
  }
});
test('unknown customer noise limit is not replaced by a universal 85', () => {
  const x=sample();Object.assign(x.cases[0],{noiseDbA:90,noiseRelation:'=',noiseBasis:'prediction',noiseLimitDbA:null});
  const r=checkCandidate(x);assert.equal(r.cases[0].noiseAssessment,'NO_LIMIT');assert.equal(r.deviations.length,0);assert.equal(r.trialPriority,'NOT_ASSESSED');
});
test('near-full travel triggers comparison; only explicit customer hard limits add a rejection', () => {
  const x=sample();x.cases[0].estimatedTravelPercent=94;
  assert.equal(checkCandidate(x).status,'READY_FOR_SOFTWARE_CHECK');
  x.cases[0].travelLimits={minPercent:10,maxPercent:90};assert.equal(checkCandidate(x).status,'REJECTED');
  x.cases[0].travelLimits={minPercent:96,maxPercent:90};assert.equal(checkCandidate(x).status,'NEEDS_DATA');
});
test('valid capacity and travel never automatically recommend high-risk downsizing', () => {
  const x=sample();Object.assign(x.cases[0],{noiseDbA:80,noiseRelation:'=',noiseBasis:'prediction',outletDensityKgM3:5});
  const r=checkCandidate(x);assert.equal(r.status,'DEVIATION_REVIEW');assert.equal(r.trialPriority,'NOT_ASSESSED');assert.equal(r.businessGatePass,false);
});
test('exceeding a stated noise limit is not automatic rejection; below it is not automatic trial approval', () => {
  const x=sample();x.direction='cv';x.candidate.bodyNominalMm=x.baseline.bodyNominalMm;
  Object.assign(x.cases[0],{noiseDbA:90,noiseRelation:'=',noiseBasis:'prediction'});
  let r=checkCandidate(x);assert.equal(r.status,'DEVIATION_REVIEW');assert.equal(r.trialPriority,'NOT_ASSESSED');
  x.cases[0].noiseDbA=70;r=checkCandidate(x);assert.equal(r.status,'READY_FOR_SOFTWARE_CHECK');assert.equal(r.trialPriority,'NOT_ASSESSED');
});
test('software-supplied calculation basis is explicit, never synthesized as an independent result or business PASS', () => {
  const x=sample();x.calculationBasis={type:'software',description:'Synthetic software baseline result'};
  const r=checkCandidate(x);assert.equal(r.calculationBasis,'software');assert.equal(r.liveValidated,false);assert.equal(r.businessGatePass,false);
});

test('overflow or underflow in derived velocity and force is reported as missing', () => {
  for (const diameter of [Number.MIN_VALUE, Number.MAX_VALUE]) {
    const x = sample(); x.cases[0].outletDiameterMm = diameter;
    const r = checkCandidate(x); assert.equal(r.status, 'NEEDS_DATA');
    assert.equal(r.cases[0].velocityMps, null); assert.equal(r.cases[0].roughVelocityMps, null);
  }
  const x = sample(); x.forceScreen = {shutoffMPa:Number.MAX_VALUE, netPressureAreaMm2:2, availableClosingN:100};
  const r = checkCandidate(x); assert.equal(r.status, 'NEEDS_DATA'); assert.equal(r.hydraulicClosingLowerBoundN, null);
});

test('special design cannot obtain basic-check approval by using an unsupported direction', () => {
  for (const direction of ['series', 'flow-direction', 'special-body', 'test-requirement']) {
    const x = sample(); x.direction = direction;
    const r = checkCandidate(x);
    assert.equal(r.status, 'REJECTED'); assert.equal(r.businessGatePass, false);
    assert.equal(r.liveValidated, false); assert.equal(r.trialPriority, 'NOT_ASSESSED');
  }
});
