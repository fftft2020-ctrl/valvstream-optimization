import importlib.util
from pathlib import Path
import re
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('export_chat', HERE / 'export-chat.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class ChatExportTests(unittest.TestCase):
    def test_complete_engineering_rows_and_no_local_dependencies(self):
        text = module.build(HERE.parent)
        for filename, pattern in [('optimization-map.md', r'^\| [1-3]\.\d+ \|.*$'),
                                  ('cost-reduction.md', r'^\| \d+ \|.*$')]:
            source = (HERE.parent / 'references' / filename).read_text()
            self.assertEqual(re.findall(pattern, source, re.M), re.findall(pattern, text, re.M))
        for phrase in ['ΔF液', '新总需求', '最低保证', '噪声', 'Notebook', '可复制的续做消息', '不能因为能解释代码就声称代码已运行']:
            self.assertIn(phrase, text)
        for forbidden in ['/home/', 'node scripts/', 'node runtime/', '## 工具与分发', '## 候选检查器与输入']:
            self.assertNotIn(forbidden, text)
        for target in re.findall(r'\]\(([^)]+)\)', text):
            self.assertRegex(target, r'^(https?://|#)')
        layout = (HERE.parent / 'references/excel-format.md').read_text()
        for row in re.findall(r'^\|.*$', layout, re.M):
            self.assertIn(row, text)
        self.assertIn('无法判定：缺新总需求', text)
        self.assertIn('恰好2张可见工作表', text)
        self.assertIn('**优化汇总、计算过程**', text)
        self.assertIn('各工况需求Cv', text)
        self.assertIn('返回汇总', text)
        self.assertNotIn('固定三表', text)
        self.assertEqual(module.build(HERE.parent), text)

if __name__ == '__main__':
    unittest.main()
