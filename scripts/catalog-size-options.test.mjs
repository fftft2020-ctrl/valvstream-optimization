import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogSizeOptions} from './catalog-size-options.mjs';
test('保留同格全部尺寸，不将两段和三段混淆',()=>{
  assert.deepEqual(catalogSizeOptions('8 10x8 12x8').map(o=>o.dimensionsIn),[[8],[10,8],[12,8]]);
  assert.deepEqual(catalogSizeOptions('3X2 (1) 4×2').map(o=>o.dimensionsIn),[[3,2],[4,2]]);
  assert.deepEqual(catalogSizeOptions('6 6x8x6').map(o=>o.dimensionsIn),[[6],[6,8,6]]);
  assert.deepEqual(catalogSizeOptions('30 32x30 FTO').map(o=>o.dimensionsIn),[[30],[32,30]]);
});
test('不认识的尺寸和非正数不能猜测',()=>{
  for(const raw of ['',null,'8/6','8x','8x0','8x6x8x6','FTO'])assert.throws(()=>catalogSizeOptions(raw));
});
