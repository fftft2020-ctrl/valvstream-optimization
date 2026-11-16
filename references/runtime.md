# 云端离线计算使用说明

本包只提供纯计算引擎、厂家曲线及合成示例，不包含客户历史、软件下拉框记录、原PDF或登录状态。运行结果是初筛依据，不能证明实际软件可选、客户符合或业务通过。需要Node.js 22+。

批量交付先按 `references/batch-review.md` 实际运行 `scripts/run-review.mjs`，并重算核对结果；下面的容量CLI用于查目录或单独计算，不替代完整批量核算。

先读取Skill根目录 `references/offline-prescreen.md`，在软件外形成方向和少量候选。曲线数据含行程元数据，但当前程序不做完整执行机构负荷或收益自动排名，包内有已注明适用范围的87/88、51、52/53执行机构参数，尚非全型号性能库；按适用厂家资料联合判断行程/执行机构潜力，缺精确推力时仍交付已支持的容量、开度与行程结论。未实现的执行机构、噪声及价格模型不能因更新了规则而声称已有。

从Skill根运行：

```bash
node runtime/pre-sizing-cli.mjs inventory
node runtime/pre-sizing-cli.mjs catalog filter.json
node runtime/pre-sizing-cli.mjs calculate fixtures/pre-sizing-gas.json --out-dir scratch/demo --cache-dir scratch/cache
```

filter.json示例：`{"series":"21000","size":"2","characteristic":"equal-percentage","flowDirection":"FTO","trimFamily":"contoured"}`。字段精确匹配，未知配置不补造；详情用`curve <ID>`，全系列曲线目录用`capacity-directory`。默认摘要仅列少量候选，完整结果在evidencePath，交付完整清单必须读取完整结果。

厂家库覆盖10000、21000、28000、33000、35002、41005、80000，以本包索引及每行来源为准；28000没有逐点开度曲线，80000三通需专项工况核对。非单调、超常行程、尺寸关联及型号资格等原疑点仍保留，不猜修。原记录中含具体案例的曲线备注在分发时改为不含案例的复核警示，厂家数值、脚注和适用配置保持不变；索引重新计算分发内容指纹，项目原库不改动。

软件下拉框与历史查询在本包没有记录，不可把空结果理解为软件无此产品。实际可选项须通过已授权软件会话确认。目录及引擎内的优先状态仅辅助读数，不能替代本Skill逐路线的风险/收益判断。

## 输入及计算范围

输入沿用 `sizing.flowUnit / pressureUnit / temperatureUnit / cases`，增加 `preSizing`。不要求报价、执行机构或附件字段来计算物理需求。

- 每个工况必须有 `name/flow/p1/p2/temperature/properties`；数字必须为有限数值，不接受空白、布尔或数字字符串。
- `properties.densityKgM3` 为入口运行状态密度，`basis` 记录物性来源。气体另需 `k`；液体另需 `vaporPressureBarA/criticalPressureBarA`。不自行估混合物物性，不默认 Z 或空气比重。
- 流量支持 `m3/h`（入口实际体积）、`L/h`、`USgpm`、`kg/h`、`t/h`。气体 `Nm3/h/Sm3/h` 必须明确 `baseDensityKgM3/baseDensityBasis/baseTemperatureK/basePressureBarA`，不猜标准状态。换成质量流量后使用入口密度计算。
- 压力支持 `bar a/g`、`kPa a/g`、`MPa a/g`、`psi a/g`（如 `bar g`）；表压须提供 `preSizing.atmosphereBar`。温度支持 `deg C/deg F/K`。
- `preSizing.phase` 为 `liquid/gas`；`singlePhase/turbulent` 必须明确为true，并用 `assessmentBasis`说明依据。它是输入假设，不是程序完成了流态识别。
- `preSizing.factors.fp` 必须给出 `value:1` 和 `basis`。当前不实现异径管 FLP/xTP 耦合；不能把不同管径条件悄悄当成等径。
- `fl/xt` 可给 `value` 或 `values`（最多8个敏感性值），并注明 `basis`。需求 Cv 汇总按显式值计算；候选预计开度优先用厂家本行/本表的唯一系数，没有唯一系数才用显式假设。缺系数返回待核对。
- `preferredTravelPercent:[min,max]` 和 `travelWindowBasis` 可定义客户/本次筛选偏好；无默认通用20–80%硬门槛。`candidateFilter` 选择系列/具体配置，或 `curveIds`精确选择行。

计算依据：已登记的 Masoneilan Sizing Handbook PDF第5页液体质量流量公式、第13页气体质量流量公式与膨胀因子、第14页比热比。统一用 kg/h、bar(a)、kg/m³，N6=27.3。液体限制压差用 `FL²(P1−FF·Pv)`、`FF=0.96−0.28√(Pv/Pc)`；气体用 `x=min((P1−P2)/P1,(k/1.4)·xT)`、`Y=1−x/(3(k/1.4)xT)`。

液体闪蒸/阻塞仅给限制容量估算并转专项复核，不自动推荐；不把FL当汽蚀损伤预测。气体阻塞可估算，但仍须噪声/速度软件校核。多级/双级/VRT、两相、黏度修正、非牛顿及管路耦合不套普通单级模型。干蒸汽若能明确为单相气相并提供入口物性可作气相筛查；不含蒸汽物性推导、湿蒸汽或凝结模型。

预计开度使用厂家逐点 Cv 曲线分段线性插值，同时对已提供的逐点FL/xT插值，求容量与需求相等的位置。无厂家曲线时不自动生成“理想等百分比”。非单调曲线、平台区间、表外需求明确返回状态。0流量是停流点，不改写成小非零流量，也不生成控制开度。

## 结果状态与复用

`PRIORITY_FOR_SOFTWARE_CHECK` 仅表示优先送软件核对；`REVIEW_REQUIRED` 表示来源/系数/配置疑点；`RANGE_OR_REGIME_REVIEW`表示表外或特殊流态；不能据离线范围排除所有live可用产品。所有结果保持 `OFFLINE_SCREENING_ONLY / liveValidated:false / businessGatePass:false`。

完整JSON同一状态内先按能反查的工况/假设比例排序，再按已有开度与所设窗口中心的最大偏离排序；只是安排核对顺序，不代表产品适用性评分。

缓存key覆盖完整输入（包括原单位、物性和假设）、计算与CLI源码hash、产品索引及选中系列文件hash。内容或版本改变自动另算，损坏缓存报错。完整文件发布后才能被其他进程读到；不同内容不覆盖已有证据。相同任务可共享 `--cache-dir`，每个Worker分别写自己的 `--out-dir`。

新会话不继承“前一代理已经验收”的结论。共享的是纯计算结果；来源、位号、数量、客户要求和正式Gate仍在本台原有流程核对。默认缓存位于输出目录下，不新增全局服务、后台任务或自动清理。

## 保留与重建

保留固定版本标签、RELEASE.json、来源及任务输入/结果。合成示例输出和缓存可用上方命令重建；任务证据不按缓存删除。代码或索引变化会改变缓存指纹，不沿用不同版本结果。先运行`python3 scripts/verify-cloud.py`核对包内完整性；维护与发布按Skill的references/sync.md执行。

尺寸查询按样本同格组合匹配：如原文字段`6 8x6 10x6`可用`size:"8x6"`查询，同时仍匹配系列、等级、特性等限制。返回保留样本原文和曲线ID，物理定义按异径评估确认，不能把检索成功当工况或产品资格通过。程序环境按本次系列和尺寸查询，不加载完整聊天曲线附录。
