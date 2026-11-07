import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewActuator} from './actuator-review.mjs';
import {checkCandidate} from './check-candidate.mjs';
import {readFileSync} from 'node:fs';
const sample=()=>({minimumSupplyMPa:.4,loadChanged:true,
 baselineDemand:{openN:5000,closeN:12000,safetyFactor:1.2,safetyFactorInclusion:'included',source:'synthetic-baseline'},
 candidateDemand:{openN:4500,closeN:8000,safetyFactor:1.2,safetyFactorInclusion:'included',source:'synthetic-recalculated-total'},
 geometry:{baselineThroatMm:60,candidateThroatMm:40,source:'synthetic-drawing',hydraulic:{areaBasis:'verified-net',source:'synthetic-force-balance',structureAndDirection:'unbalanced; positive opposes motion, negative assists',pressureDropMPa:2,baselineSignedNetAreaMm2:{open:2000,close:-2000},candidateSignedNetAreaMm2:{open:1000,close:-1000}}},
 capacities:[{model:'synthetic-small',openN:9000,closeN:9000,supplyMPa:.4,source:'synthetic-capacity',outputBasis:'nominal upper bound; losses pending'}]});
test('old load can fail while independently recalculated new load fits; no cross-scope rejection',()=>{
 const r=reviewActuator(sample());assert.equal(r.comparisons[0].baselineDemandComparison.verdict,'INSUFFICIENT');assert.equal(r.comparisons[0].candidateVerdict,'MARGIN');
 assert.equal(r.hydraulicChangeN.open,-2000);assert.equal(r.hydraulicChangeN.close,2000);
});
test('smaller throat actively computes supported hydraulic change even if total load is missing',()=>{
 const x=sample();delete x.candidateDemand;const r=reviewActuator(x);
 assert.equal(r.hydraulicChangeN.open,-2000);assert.equal(r.newLoadComplete,false);
 assert.equal(r.comparisons[0].candidateVerdict,'NEW_LOAD_NOT_CALCULATED');assert.equal(r.comparisonComplete,true);
});
test('same throat produces zero circular-area change, not invented force savings',()=>{
 const x=sample();x.geometry.candidateThroatMm=60;delete x.geometry.hydraulic;
 x.geometry.missingNetAreaEvidence=['pilot balance diameter not present in supplied drawing'];
 const r=reviewActuator(x);assert.equal(r.throatAreaChangeMm2,0);assert.equal(r.hydraulicChangeN,null);assert(r.pending.some(x=>x.includes('喉径未变')));
});
test('throat area cannot stand in for net pressure area, even with numeric inputs',()=>{
 const x=sample();x.geometry.hydraulic.areaBasis='throat-circle';const r=reviewActuator(x);
 assert.equal(r.hydraulicChangeN,null);assert(r.missing.some(x=>x.includes('净受压面积')));
});
test('unknown net area must name the searched source and actual missing dimensions',()=>{
 const x=sample();delete x.geometry.hydraulic;assert(reviewActuator(x).missing.some(x=>x.includes('逐项记录')));
 x.geometry.missingNetAreaEvidence=['catalog lists throat, not pilot-seat or balance diameter'];assert(!reviewActuator(x).missing.some(x=>x.includes('逐项记录')));
});
test('both directions, safety factor branches and failed candidates stay visible',()=>{
 const x=sample();x.loadChanged=false;x.baselineDemand={...x.baselineDemand,closeN:8000,safetyFactorInclusion:'unknown'};
 const r=reviewActuator(x),a=r.comparisons[0];assert.equal(a.candidateVerdict,'FACTOR_BASIS_REQUIRED');
 assert.equal(a.candidateDemandComparison.margins.close.marginIfIncludedN,1000);assert.equal(a.candidateDemandComparison.margins.close.marginIfExcludedN,-600);
 x.baselineDemand.openN=10000;assert.equal(reviewActuator(x).comparisons.length,1);assert.equal(reviewActuator(x).comparisons[0].candidateVerdict,'INSUFFICIENT');
});
test('stroke-only declaration, absent models and supply mismatch cannot complete comparison',()=>{
 assert.equal(reviewActuator({strokeShortened:true}).comparisonComplete,false);
 const x=sample();x.capacities[0].supplyMPa=.6;assert.equal(reviewActuator(x).comparisonComplete,false);
 x.capacities=[];assert.equal(reviewActuator(x).comparisonComplete,false);
});
test('invalid numbers and overflow are rejected without NaN-as-success',()=>{
 for(const n of [NaN,Infinity,'2000']){const x=sample();x.geometry.hydraulic.baselineSignedNetAreaMm2.open=n;assert.equal(reviewActuator(x).hydraulicChangeN,null);}
 const x=sample();x.baselineDemand.closeN=Number.MAX_VALUE;x.baselineDemand.safetyFactor=2;
 assert.equal(reviewActuator(x).comparisonComplete,false);
});
test('candidate checker exposes missing actuator work and rejects only relevant new load failure',()=>{
 const x=JSON.parse(readFileSync(new URL('./fixtures/candidate.json',import.meta.url)));
 assert.equal(checkCandidate(x).actuatorReview.comparisonComplete,false);
 x.actuatorReview=sample();let r=checkCandidate(x);assert.equal(r.status,'READY_FOR_SOFTWARE_CHECK');
 delete x.actuatorReview.candidateDemand;r=checkCandidate(x);assert.equal(r.status,'NEEDS_DATA');assert.equal(r.rejected.length,0);
 x.actuatorReview.loadChanged=false;r=checkCandidate(x);assert.equal(r.status,'REJECTED');
});
