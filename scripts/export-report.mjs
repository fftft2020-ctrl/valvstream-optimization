#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {buildReportModel,reportStrategies,caseName} from './report-model.mjs';
import {displayNumber,numberFormat} from './presentation.mjs';

const C={dark:'#003532',line:'#00CEB0',light:'#EEFAF8',link:'#007D62'};
const col=i=>String.fromCharCode(65+i);
const shown=(v,kind)=>typeof v==='number'?displayNumber(v,kind):String(v??'待核');
const sha=b=>createHash('sha256').update(b).digest('hex');

// Layout reused from the validated three-sheet report; engineering values are read from the frozen result.
export async function exportReport(resultPath,planPath,outputPath,{previewDir}={}) {
  const resultBytes=await fs.readFile(resultPath),planBytes=await fs.readFile(planPath),plan=JSON.parse(planBytes);
  assert.equal(plan.resultSha256,sha(resultBytes),'报告计划未绑定这份冻结计算结果');
  const model=buildReportModel(JSON.parse(resultBytes),plan,await reportStrategies());
  await fs.access(outputPath).then(()=>{throw new Error('输出已存在，请另用文件名');},()=>{});
  const require=createRequire(path.join(process.cwd(),'package.json'));
  const {Workbook,SpreadsheetFile}=await import(pathToFileURL(require.resolve('@oai/artifact-tool')));
  const wb=Workbook.create(),sum=wb.worksheets.add('优化汇总'),calc=wb.worksheets.add('计算过程'),strat=wb.worksheets.add('优化策略');
  const cells=[],links=[],blocks=[],strategyRows=new Map(model.strategies.map((s,i)=>[s.id,i+2]));
  const maxCalc=model.schemes.reduce((n,s)=>n+12+s.configurationRows.length+s.operatingCases.length+s.demandRows.length+s.actuatorRows.length,2);
  function put(sh,address,value,kind) {
    const anchor=address.split(':')[0];if(address.includes(':'))sh.mergeCells(address);
    sh.getRange(anchor).values=[[value]];
    if(typeof value==='number')sh.getRange(anchor).setNumberFormat(numberFormat(value,kind||'count'));
    cells.push({sheet:sh.name,cell:anchor,value});
  }
  function band(sh,address,dark=false){sh.getRange(address).format={fill:dark?C.dark:C.light,font:{bold:true,color:dark?'#FFFFFF':C.dark},borders:{bottom:{style:'thin',color:C.line}}};}
  function height(sh,row,points){sh.getRange(`A${row}:K${row}`).format.rowHeight=points;}
  function link(sh,cell,targetSheet,targetCell){links.push({sheet:sh.name,cell,targetSheet,targetCell});sh.getRange(cell).format.font={color:C.link,underline:'single'};}
  for(const [sh,lastColumn,lastRow] of [[sum,'K',Math.max(2,model.schemes.length+1)],[calc,'K',maxCalc],[strat,'E',model.strategies.length+1]]) {
    sh.showGridLines=false;sh.tabColor=C.dark;sh.freezePanes.freezeRows(1);
    sh.getRange(`A1:${lastColumn}${lastRow}`).format={font:{name:'Noto Sans CJK SC',size:11,color:C.dark},fill:'#FFFFFF',horizontalAlignment:'center',verticalAlignment:'center',wrapText:true,rowHeight:28};
  }
  [20,11,8,17,25,40,23,23,30,36,12].forEach((w,i)=>sum.getRange(`${col(i)}1:${col(i)}${Math.max(2,model.schemes.length+1)}`).format.columnWidth=w);
  calc.getRange(`A1:K${maxCalc}`).format.columnWidth=15;
  [12,29,45,48,35].forEach((w,i)=>strat.getRange(`${col(i)}1:${col(i)}${model.strategies.length+1}`).format.columnWidth=w);
  ['位号','原阀尺寸\n（in）','数量\n（台）','方案编号','调整方法','配置对照：原方案 → 优化方案','需求CV：原方案 → 优化方案','开度（%）：原方案 → 优化方案','主要好处','修改原因','查看计算'].forEach((s,i)=>put(sum,`${col(i)}1`,s));band(sum,'A1:K1',true);height(sum,1,48);
  put(calc,'A1:K1','计算过程（计算快照，编辑本表不会自动重算）');band(calc,'A1:K1',true);height(calc,1,30);
  ['策略编号','策略名称','适用情况与改法','核对要点','本次采用方案'].forEach((s,i)=>put(strat,`${col(i)}1`,s));band(strat,'A1:E1',true);height(strat,1,36);
  let row=3;
  function compare(title,rows,optimized='优化方案') {
    if(!rows.length)return;
    put(calc,`A${row}:C${row}`,title);put(calc,`D${row}:G${row}`,'原方案');put(calc,`H${row}:K${row}`,optimized);band(calc,`A${row}:K${row}`);row++;
    for(const r of rows){put(calc,`A${row}:C${row}`,r.label+(r.unit?`（${r.unit}）`:''));put(calc,`D${row}:G${row}`,r.original,r.kind);put(calc,`H${row}:K${row}`,r.optimized,r.kind);height(calc,row,Math.max(28,...[r.original,r.optimized].map(v=>Math.ceil(String(v).length/32)*18+8)));row++;}
  }
  for(const [i,s] of model.schemes.entries()) {
    const sr=i+2,start=row;
    const configuration=s.configurationRows.map(r=>{
      if(r.label==='执行机构'){
        const a=String(r.original).match(/^(\d+)系列，(.+)号$/),b=String(r.optimized).match(/^(\d+)系列，(.+)号$/);
        if(a&&b&&a[1]===b[1])return `执行机构 ${a[1]}系列，${a[2]}号 → ${b[2]}号`;
      }
      return `${r.label} ${shown(r.original,r.kind)} → ${shown(r.optimized,r.kind)}${r.unit?' '+r.unit:''}`;
    }).join('\n');
    const cv=s.operatingCases.length?s.operatingCases.map(c=>`${caseName(c.name)} ${shown(c.originalRequiredCv,'cv')} → ${shown(c.optimizedRequiredCv,'cv')}`).join('\n'):'不变';
    const opening=s.operatingCases.length?s.operatingCases.map(c=>`${caseName(c.name)} ${shown(c.originalOpeningPercent,'opening')} → ${shown(c.optimizedOpeningPercent,'opening')}`).join('\n'):'不变';
    const methods=s.strategyIds.map(id=>id+' '+model.strategies.find(t=>t.id===id).name).join('\n');
    [s.tag,s.originalSizeIn,s.quantity??'待核',s.schemeId,methods,configuration,cv,opening,s.benefit,s.reason,'查看计算'].forEach((v,j)=>put(sum,`${col(j)}${sr}`,v,j===1?'length':'count'));
    const lines=Math.max(...[methods,configuration,cv,opening,s.benefit,s.reason].map(t=>t.split('\n').reduce((n,l)=>n+Math.max(1,Math.ceil(l.length/21)),0)));
    height(sum,sr,Math.max(72,lines*17+12));sum.getRange(`F${sr}`).format.fill=C.light;
    link(sum,`K${sr}`,'计算过程',`A${start}`);link(sum,`E${sr}`,'优化策略',`A${strategyRows.get(s.strategyIds[0])}`);
    put(calc,`A${row}:H${row}`,`${s.tag}　${s.schemeId}`);put(calc,`I${row}:K${row}`,'返回汇总');band(calc,`A${row}:K${row}`,true);link(calc,`I${row}`,'优化汇总',`A${sr}`);calc.getRange(`I${row}`).format.font.color='#FFFFFF';height(calc,row,34);row++;
    compare('改动配置',s.configurationRows);
    if(s.operatingCases.length) {
      const cases=s.operatingCases,temps=[...new Set(cases.map(c=>c.temperatureC))],variable=temps.length>1;
      const flow=cases[0].flowUnit,pressure=cases[0].pressureUnit;
      assert(cases.every(c=>c.flowUnit===flow&&c.pressureUnit===pressure),'不同单位须先按原表分组，不能套同一表头');
      put(calc,`A${row}:K${row}`,`受影响工况${variable?'':`，温度${shown(temps[0],'temperature')}°C`}${cases.some(c=>c.coarseVelocity)?'；优化出口流速为粗估':''}`);band(calc,`A${row}:K${row}`);height(calc,row,32);row++;
      const headers=['工况',`流量\n${flow}`,`入口压力\n${pressure}`,`出口压力\n${pressure}`,...(variable?['温度\n°C']:[]),'原需求CV','优化需求CV','原开度\n%','优化开度\n%','原阀出口速度\nm/s','优化阀出口速度\nm/s'];
      headers.forEach((h,j)=>put(calc,`${col(j)}${row}`,h));band(calc,`A${row}:${col(headers.length-1)}${row}`);height(calc,row,46);row++;
      for(const c of cases){const values=[caseName(c.name),c.flowValue,c.p1,c.p2,...(variable?[c.temperatureC]:[]),c.originalRequiredCv,c.optimizedRequiredCv,c.originalOpeningPercent,c.optimizedOpeningPercent,c.originalOutletVelocityMps,c.optimizedOutletVelocityMps];const kinds=['text','flow','pressure','pressure',...(variable?['temperature']:[]),'cv','cv','opening','opening','velocity','velocity'];values.forEach((v,j)=>put(calc,`${col(j)}${row}`,v,kinds[j]));height(calc,row,Math.max(28,...values.map(v=>typeof v==='string'?Math.ceil(v.length/8)*17+8:28)));row++;}
    }
    compare('要求的开关力',s.demandRows,s.demandHeader);
    compare('执行机构名义输出',s.actuatorRows);
    blocks.push({schemeId:s.schemeId,summaryRow:sr,start,end:row-1});row+=2;
  }
  for(const [i,t] of model.strategies.entries()) {
    const r=i+2,uses=model.schemes.map((s,index)=>({s,row:index+2})).filter(x=>x.s.strategyIds.includes(t.id));
    const values=[t.id,t.name,t.use,t.check,uses.length?uses.map(x=>`${x.s.tag} ${x.s.schemeId}`).join('\n'):'本次未采用'];values.forEach((v,j)=>put(strat,`${col(j)}${r}`,v));
    height(strat,r,Math.max(64,Math.max(Math.ceil(t.use.length/20),Math.ceil(t.check.length/22),uses.length*2)*17+12));if(uses.length)link(strat,`E${r}`,'优化汇总',`A${uses[0].row}`);
  }
  const end=Math.max(1,row-3);if(end<maxCalc)calc.getRange(`A${end+1}:K${maxCalc}`).clear({applyTo:'all'});
  wb.recalculate();
  const inspected=await wb.inspect({kind:'match',searchTerm:'#REF!|#DIV/0!|#VALUE!|#NAME\\?|#NUM!|#SPILL!',options:{useRegex:true,maxResults:30}});
  if(previewDir){await fs.mkdir(previewDir,{recursive:true});for(const [sheetName,range,name] of [[sum.name,`A1:K${Math.min(4,model.schemes.length+1)}`,'summary'],[calc.name,blocks.length?`A${blocks[0].start}:K${blocks[0].end}`:'A1:K1','calculation'],[strat.name,'A1:E5','strategies']]){const blob=await wb.render({sheetName,range,scale:1,format:'png'});await fs.writeFile(path.join(previewDir,name+'.png'),new Uint8Array(await blob.arrayBuffer()));}}
  const audit={resultSha256:sha(resultBytes),planSha256:sha(planBytes),blocks,cells,links,inspection:inspected.ndjson,sheets:[{name:sum.name,lastCol:'K',lastRow:model.schemes.length+1},{name:calc.name,lastCol:'K',lastRow:end},{name:strat.name,lastCol:'E',lastRow:model.strategies.length+1}]};
  await fs.mkdir(path.dirname(outputPath),{recursive:true});
  const temporary=outputPath+'.partial.xlsx',auditPath=outputPath+'.audit.json';
  await fs.writeFile(auditPath,JSON.stringify(audit,null,2)+'\n',{flag:'wx'});
  await (await SpreadsheetFile.exportXlsx(wb)).save(temporary);
  execFileSync(process.env.PYTHON||'python3',[fileURLToPath(new URL('./finalize-report.py',import.meta.url)),temporary,auditPath,outputPath],{stdio:'pipe'});
  await fs.unlink(temporary);
  return {output:outputPath,schemes:model.schemes.length,internalLinks:links.length,exportedCellsVerified:true};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{const [result,plan,output,preview]=process.argv.slice(2);if(!output||process.argv.length>6)throw new Error('Usage: node export-report.mjs result.json report-plan.json output.xlsx [preview-directory]');console.log(JSON.stringify(await exportReport(result,plan,output,{previewDir:preview})));}
  catch(e){console.error(e.message);process.exitCode=1;}
}
