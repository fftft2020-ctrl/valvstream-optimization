import copy
import importlib.util
import json
from pathlib import Path
import re
import unittest

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('chat_curves',HERE/'chat-curves.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class CurveAttachmentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text=(HERE.parent/'references/chat-curve-library.md').read_text()

    def test_all_fields_curves_and_dense_bounds(self):
        result=module.verify(self.text,HERE.parent,dense=True)
        self.assertEqual(sum(result['curveKinds'].values()),1275)
        self.assertGreater(result['sparseRecords'],0)
        self.assertGreater(result['sparseTemplates'],0)
        self.assertEqual(result['coverage'],{'21000':734,'35002':89,'41005':452})
        self.assertEqual(result['tables'],47)

    def test_actual_header_and_geometry_references_are_checked(self):
        for heading in ['## 公共原表行H库','## 公共尺寸原字段G库']:
            before,after=self.text.split(heading,1)
            if 'H库' in heading:
                after=after.replace('Cv','TAMPERED',1)
            else:
                after=after.replace('G1\t','G0\t',1)
            self.assertNotEqual(before+heading+after,self.text)
            with self.assertRaises((AssertionError,ValueError,KeyError)):
                module.verify(before+heading+after,HERE.parent)

    def test_modified_template_and_missing_row_fail(self):
        before,after=self.text.split('## 共享曲线模板',1)
        block=re.search(r'```json\n(.*?)\n```',after,re.S)
        lib=json.loads(block[1]);lib['S1']=module.expand_points(lib['S1'],list(range(10,101,10)));lib['S1'][1]*=2
        tampered=before+'## 共享曲线模板'+after[:block.start(1)]+json.dumps(lib)+after[block.end(1):]
        with self.assertRaises(AssertionError):module.verify(tampered,HERE.parent)
        removed=re.sub(r'^R\d+\t[^\n]+\n','',self.text,count=1,flags=re.M)
        with self.assertRaises((AssertionError,ValueError)):module.verify(removed,HERE.parent)

    def test_sparse_coordinates_and_invalid_indices(self):
        self.assertEqual(module.expand_points('P02:1,9',[10,30,90]),[1,3,9])
        for spec in ['P00:1,9','P20:1,9','P01:1,9','P02:1','P02:1,nan']:
            with self.assertRaises(AssertionError):module.expand_points(spec,[10,30,90])

    def test_total_error_is_measured_against_original(self):
        spec=importlib.util.spec_from_file_location('compact',HERE/'compact-chat-curves.py')
        compact=importlib.util.module_from_spec(spec);spec.loader.exec_module(compact)
        t={'review':[],'travelPercent':[10,20,100]}
        row=[1,1,[1,2,3],3,None,[],{}]
        limits={'relativeCv':0.05,'openingPercentagePoints':1}
        self.assertTrue(compact.acceptable(t,row,[1,2.01,3],limits))
        self.assertFalse(compact.acceptable(t,row,[1,2.11,3],limits))
        t['review']=['source issue']
        self.assertFalse(compact.acceptable(t,row,[1,2.01,3],limits))

if __name__=='__main__':unittest.main()
