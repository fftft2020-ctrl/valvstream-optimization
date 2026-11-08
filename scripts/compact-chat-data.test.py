import importlib.util
import json
from pathlib import Path
import re
import unittest

HERE=Path(__file__).resolve().parent

def load(name):
    spec=importlib.util.spec_from_file_location(name,HERE/(name+'.py'))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

compact=load('compact-chat-data')
curves=load('chat-curves')

class CompactDataTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.original=(HERE.parent/'references/chat-curve-library.md').read_text()
        cls.text=compact.compact(cls.original)

    def test_roundtrip_all_fields_and_curves(self):
        self.assertEqual(curves.parse(self.text),curves.parse(self.original))
        self.assertEqual(compact.compact(self.text),self.text)
        self.assertLess(len(self.text.encode()),len(self.original.encode())*.9)
        self.assertTrue(curves.verify(self.text,HERE.parent,dense=True)['allNonCurveFieldsPreserved'])
        self.assertIn('只有3列',self.text)

    def test_invalid_geometry_note_and_row_references_fail(self):
        variants=[self.text.replace('G1\t','G1\t=\t',1),
                  re.sub(r'"contextRefs":\[\d+','"contextRefs":[0',self.text,count=1),
                  re.sub(r'"rowStart":\d+','"rowStart":999',self.text,count=1)]
        for text in variants:
            self.assertNotEqual(text,self.text)
            with self.assertRaises((AssertionError,ValueError,KeyError)):
                curves.verify(text,HERE.parent)

    def test_header_positions_and_repeat_values_are_verified(self):
        heading='## 公共原表行H库';before,after=self.text.split(heading,1)
        block=re.search(r'```json\n(.*?)\n```',after,re.S);pool=json.loads(block[1])
        pool['sparseRows'][0][1]=999
        changed=before+heading+after[:block.start(1)]+json.dumps(pool)+after[block.end(1):]
        with self.assertRaises(AssertionError):curves.verify(changed,HERE.parent)
        block=next(m for m in re.finditer(compact.PATTERN,self.text,re.S) if '"repeat"' in m[1])
        meta=json.loads(block[1]);factor=next(f for f in meta['factorRows'] if isinstance(f['values'],dict))
        factor['values']['repeat'][0]=0.12345
        changed=self.text[:block.start(1)]+json.dumps(meta,separators=(',',':'))+self.text[block.end(1):]
        self.assertNotEqual(changed,self.text)
        with self.assertRaises(AssertionError):curves.verify(changed,HERE.parent)
        for bad in [{'repeat':[0.9,-1]},{'repeat':[0.9,1.5]}]:
            with self.assertRaises(AssertionError):compact.expand_repeat(bad)

if __name__=='__main__':unittest.main()
