import importlib.util
from pathlib import Path
import re
import unittest
import tempfile
import shutil

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('export_chat', HERE / 'export-chat.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class ChatExportTests(unittest.TestCase):
    def test_complete_engineering_rows_and_no_local_dependencies(self):
        text = module.build(HERE.parent)
        for filename, pattern in [('optimization-map.md', r'^\| [1-3]\.\d+ \|.*$'),
                                  ('cost-reduction.md', r'^\| (?:[1-9]|[12]\d|3[0-8]) \|.*$')]:
            source = (HERE.parent / 'references' / filename).read_text()
            anchor,following = ('methods','cases') if filename=='optimization-map.md' else ('cases','curve-library')
            exported = text.split(f'<a id="{anchor}"></a>',1)[1].split(f'<a id="{following}"></a>',1)[0]
            self.assertEqual(re.findall(pattern, source, re.M), re.findall(pattern, exported, re.M))
        for phrase in ['ΔF液', '新总需求', '最低保证', '噪声', 'Notebook', '可复制的续做消息', '不能因为能解释代码就声称代码已运行']:
            self.assertIn(phrase, text)
        for forbidden in ['/home/', 'node scripts/', 'node runtime/', '## 工具与分发', '## 候选检查器与输入']:
            self.assertNotIn(forbidden, text)
        for target in re.findall(r'\]\(([^)]+)\)', text):
            self.assertRegex(target, r'^(https?://|#)')
        layout = (HERE.parent / 'references/excel-format.md').read_text()
        for row in re.findall(r'^\|.*$', layout, re.M):
            self.assertIn(row, text)
        for phrase in ['原需求作为有条件上限', '条件余量=候选输出−原需求采用门槛', '最低需降低', '不是新负荷预测', '余量<0不证明新方案失败']:
            self.assertIn(phrase, text)
        self.assertIn('恰好3张可见工作表', text)
        self.assertIn('**优化汇总、计算过程、优化策略**', text)
        self.assertIn('各工况需求Cv', text)
        self.assertIn('返回汇总', text)
        self.assertIn('采用策略', text)
        self.assertNotRegex(text, r'(?<!执行)机' + '构')
        for phrase in ['策略编号', '本次采用方案', '沿用1.1–3.4', '链接到本表对应行']:
            self.assertIn(phrase, text)
        for old in ['恰好2张', '固定9列', '无第三表']:
            self.assertNotIn(old, text)
        for phrase in ['先确定批次口径，再进行优化', '不能单独证明不含系数', '原系数→1.0→原系数', '不在正式三表反复铺开']:
            self.assertIn(phrase, text)
        for phrase in ['用原执行机构反查', '回溯原选型采用原供气', '两方向再乘k仍在能力内', '不能除以k消除矛盾', '最小档前提未证实', '按有区分力样本的主导结果', '记录双方数量、范围']:
            self.assertIn(phrase, text)
        self.assertLess(text.index('## 先确定批次口径，再进行优化'), text.index('## 容量、开度、几何与流速'))
        for phrase in ['先确定批次口径，再进行优化', '不是未含票', '异常只暂停受影响阀门', '按该口径得到的条件余量', '不把1.3写成所有任务的默认值', '没有有区分力样本、双方接近']:
            self.assertIn(phrase, text)
        self.assertNotIn('包含关系未证实时不填唯一门槛', text)
        self.assertNotIn('有直接定义或完整力平衡后，再按1.1节统一门槛', text)
        self.assertNotIn('每方向明确分“已含／未含”两行', text)
        for phrase in ['1,275条曲线配置', '精简数据读法', '常用执行机构参数', 'G库', 'H库', 'S编号', '先确定批次口径，再进行优化']:
            self.assertIn(phrase, text)
        self.assertNotIn('不含客户数据、厂家曲线库', text)
        for phrase in ['Fγ=γ/1.4', 'Y=1−x/(3×Fγ×xT)', '0.0980665 MPa', '4.448222 N', 'IEC60534-8-4:2015', '返回汇总', '全部文字小数', 'ΔF密封', '较小执行机构余量']:
            self.assertIn(phrase,text)
        self.assertNotIn('## 工程范围、固定边界与完整流程',text)
        self.assertEqual(module.build(HERE.parent), text)

    def test_actuator_catalog_survives_export_with_size_and_travel_specific_limits(self):
        text = module.build(HERE.parent)
        source = (HERE.parent / 'references/chat-curve-library.md').read_text()
        section = source.split('## 常用执行机构参数', 1)[1].split('本附录是聊天环境', 1)[0]
        self.assertIn(section, text)
        rows = [tuple(x.strip() for x in row.split('|')[1:-1])
                for row in re.findall(r'^\| 51-[^\n]+$', section, re.M)]
        expected = [
            ('51-12','单','112.8/111.8','4','50232'),
            ('51-16','单','181.2/179.8','6/12','80661'),
            ('51-16L','单','181.2/179.8','30','80661'),
            ('51-20','单','289.7/287.4','6/12','128961'),
            ('51-20L','单','289.7/287.4','30','128961'),
            ('51-24','双','359.9/356','6/12','123066'),
            ('51-24L','单','397.7/395.4','6/30','177054'),
            ('51-28','双','576.9/573','6/12','197266'),
            ('51-28L','单','605/602.6','6/12','269307'),
            ('51-32','双','795.9/788','6/12','256750'),
            ('51-32L','单','808.5/804.3','6/12','359904'),
            ('51-40','双','1204/1198.9','6','388400')]
        self.assertEqual(rows, expected)
        springs = [tuple(x.strip() for x in row.split('|')[1:-1]) for row in re.findall(
            r'^\| (?:12/16/20|16/20) \|[^\n]+$', section, re.M)]
        self.assertEqual(springs, [
            ('12/16/20','3.75','10–24/20–39/25–48','11–25/21–40/27–50'),
            ('12/16/20','3.5','10–23/20–38/25–47','12–25/22–40/28–50'),
            ('12/16/20','3','10–21/20–35/25–44','14–25/25–40/31–50'),
            ('16/20','5.5','10–24/20–38/25–48','11–25/22–40/27–50'),
            ('16/20','5','10–23/20–37/25–46','12–25/23–40/29–50'),
            ('16/20','2.25','10–24/20–38/25–48','11–25/22–40/27–50'),
            ('16/20','2','10–22/20–36/25–45','13–25/24–40/30–50')])
        for row in springs:
            for cell in row[2:]:
                pairs = [tuple(map(float, x.split('–'))) for x in cell.split('/')]
                self.assertEqual(len(pairs), 3)
                self.assertTrue(all(0 < a < b for a,b in pairs))
        for phrase in ['52/53-12 | 112 | 4', '52/53-16 | 180 | 2.5/4/6',
                       '52/53-20 | 287 | 2.5/4/6', '双活塞不能再乘2',
                       'L版压力上限须查适用铭牌', '不借用2in范围',
                       '不采用7/8 bar提高限值', '9 psi配920 mbar',
                       '不是阀门角度', '5S仅有缸径和弹簧信息，未给有效面积',
                       '| 4.5 | 14 | 3.5 | 7–15/7–15 | 45 |',
                       '| 6 | 24 | 5.75 | 7–15/7–15 | 45 |',
                       '| 7 | 36 | 7.25 | 7–24/7–24 | 75 |',
                       '| 9 | 75 | 7.25 | 8–25/7–24 | 75 |']:
            self.assertIn(phrase, section)

    def test_changed_full_rule_cannot_silently_use_old_compact_workflow(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            for name in [*module.RULE_SOURCES,'data/chat-rule-sources.json']:
                target=root/name;target.parent.mkdir(parents=True,exist_ok=True)
                shutil.copy2(HERE.parent/name,target)
            module.check_rule_sources(root)
            changed=root/'references/actuator-force-followup.md'
            changed.write_text(changed.read_text()+'\n新约束：示例变更，精简规则须重新复核。\n')
            with self.assertRaisesRegex(ValueError,'review compact workflow'):
                module.check_rule_sources(root)

if __name__ == '__main__':
    unittest.main()
