# 批量核算输入与交付

适用于完整程序包或本项目代码环境。原始表格提取与来源判断仍由代理完成；程序统一执行可重复计算、完整枚举和取舍，不从模型记忆取厂家数据。

## 直接运行

从本Skill目录运行（Node.js 22+）：

```bash
node scripts/run-review.mjs scripts/fixtures/batch.json /tmp/synthetic-review.json
node scripts/run-review.mjs scripts/fixtures/batch.json /tmp/synthetic-review.json --verify
```

示例是合成数据，不能套用其气源、系数或需求。实际任务另存输入；输出文件已存在时拒绝覆盖。修改计算输入或程序后另用结果文件名。`--verify`比较所有数值、采用方案和计算指纹；只有SKILL文字指纹变化时返回ruleVersionChanged/ruleReviewRequired，提示复读规则，不能据此声称新工程规则已应用。旧schemaVersion=1结果使用其冻结包重算核对；仅排版直接沿用旧结果，不为展示生成新计算文件。

## 输入

顶层：`schemaVersion:1`，`valves`（逐台清单），可选`displayLimit`（只限制主展示，默认3）。每台：

- `id`、`source`：唯一位号和原始文件/表/行或页；源文件另保存SHA256。
- `sourceCases`：全部原工况，至少`name`与`massFlowKgH`。停流点为0；原单位、原值及转换依据保留在提取资料。
- `baseline`：原`bodyNominalMm/ratedCv/packing`；`pipeNominalMm`有`inlet/outlet`。尺寸按标准对应；完整填料不缩成一个材质名。
- `capacityInput`：适用既有引擎时，原样使用[容量运行说明](runtime.md)的`sizing/preSizing`输入。程序实际调用容量引擎、核验厂家数据指纹，且核对工况与`sourceCases`一致。候选用`curveId`绑定结果；程序填回额定Cv、需求Cv、预计开度及可解析的实际行程。不支持的工况/结构不硬套。
- `actuator`：`minimumSupplyMPa`为本轮最低保证表压；`positioner`为有来源的型号/气路；`baselineDemand`含`openN/closeN/safetyFactor/safetyFactorInclusion/source`，包含关系为`included/excluded/unknown`；`original`含`type/size/travelIn/spring`。52/53另明确`airAction:"air-to-open"|"air-to-close"`；51的`airAction`不能证明上下腔对应开关；有独立装配依据时给`original.chamberMapping:{opening:"upper"|"lower",source,configurationRef}`，缺失时两方向都按较小腔面积作保守名义比较。不能用候选自行算好的输出力代替这些输入。
- `candidates`：全部备选，包括备查和后排方案。每项含唯一`id`、`kind:capacity|special`、`route`、`upstreamPriority`和`decisionBasis`。优先级及收益是有依据的工程判断，不由容量状态自动升级；没有候选的位号仍须列出已排查方向和缺项，不能从任务清单删掉；`candidates:[]`时必须有`noCandidateReason`。

有厂家准确曲线的保留阀体缩内件结构可用`check.direction:"structure"`，同时提供有来源的`structuralChange`；允许CV不变但不因此免除结构/收益核对。该路线不改变所核阀体口径，不把新内件名义尺寸当成阀出口直径。

基础候选的`check`沿用`fixtures/candidate.json`，但`baseline/pipeNominalMm/sourceCases`统一取本台原数据。`capacityInput`未能使用时，`check`必须保留已有计算的方法、参数、来源、各工况值及限制，不能把原报告引用当本轮重算。`check.actuatorReview/forceScreen`不接受：输出力必须由本入口统一计算。特殊候选用`specialAssessment`记录独立工程依据，不套基础路线冒充通过。异径候选同时保存`catalogMatch`（匹配类型、样本尺寸原文与定义、对应的三段显示尺寸及对应依据、目标组合、页码/曲线、差别和缺项）；已有准确曲线可按实际配置使用capacity计算，只有设计方向则使用special，未算值不填0。缺参数逐项记录，不把未知直接写成不适用。组合拆出的独立方案分别给候选id、实际变化及依据，不能直接拷贝原组合的计算结论。

每项`actuation`含`travelIn/loadChanged`、`geometry`、可选新`candidateDemand`及`baselineBound`。明确采用机构时给`selection:{type,size,travelIn,spring}`（无弹簧时spring为null），必须精确匹配本轮枚举。所有特殊方案显式给`required`：涉及机构或受力变更为true，独立阀盖等无关改动为false；未说明只留待核、不进入展示，不默认跳过机构检查。独立阀盖方案不受其他机构失败连带影响。完整新需求下采用组合或已知完整枚举全不足才排除；只对旧需求不足不判新负荷失败。`geometry`沿用推力检查字段，新增：

```json
{"baselineQualification":{"kind":"exact-catalog","source":"厂家目录版本及页码","configurationRef":"原完整配置"},"candidateQualification":{"kind":"as-built","source":"已核实的实际装配参数及来源","configurationRef":"候选完整配置"}}
```

两者也可为`inferred/unknown`；缺失或类比仍计算旧负荷对照，不能作为新负荷上限。喉径相同不证明液压力、密封摩擦或其他负荷不增加，开/关上限前提分别保留。原规格书未能精确匹配厂家曲线时，不得借相近档位并标成`exact-catalog`。

## 结果怎么用

`valves[].actuators`记录原机构及每个候选在新行程下的全部适用档位/弹簧、已扣气路压差的输出、旧/新需求对照、缺项及覆盖数；结果schemaVersion=2，`records`用`actuatorRef`和`check.curveRef`关联完整结果，每份数据只保存一次；`getReviewRecord(valve,id)`恢复读取视图并兼容冻结v1结果。`selectedSchemeIds`仅表示主表展示。**先核算全部方案，再限制展示数量**；不因未被选入主表跳过较短行程方案。

缺少新负荷时，本地审查读取每个combinations[].review.comparisons中的baselineReferenceHeadroom，核对开启/关闭的原需求对照差额N及百分比，注明按N/百分比的较紧方向；有新负荷时仍区分原需求对照与新负荷差额。保留原尺寸须按候选新行程和适用弹簧计算。不把旧负荷不足当新方案必然失败，也不把旧负荷覆盖称新方案通过。原/候选几何类比时不能启用程序的工程条件上限；用户明确授权的“≤原值（假设上限）”另存展示假设，不改写几何资格或工程状态。未知型号或未覆盖弹簧不能把空清单称为全部检查完成。`engineeringQualified:false`始终保留：现有程序不完成厂家安装接口、全行程负荷、动作时间、完整气路、噪声及供货资格确认。

先用`node scripts/review-result.mjs result.json`读摘要；仅需某台完整记录时追加位号。Excel使用[固定生成入口](excel-format.md#固定生成入口)读取结果值，不另写推力/弹簧算法。固定三表按[表格格式](excel-format.md)：只显示实际降本改动和受影响结果，余量、差额及完整依据留本地；仅取消加长阀盖不列开关力。导出后核对位号、所选配置、受影响工况、原/新开关力及假设标识；完整候选、气源损失、余量和依据等级在本地审查记录核对。程序复现不代替这个成品核对。

保留原输入、结果、导出文件和所用Skill包/RELEASE.json。仅合成测试输出可按上面的命令重建；客户原始资料和审计证据不作缓存清理。
