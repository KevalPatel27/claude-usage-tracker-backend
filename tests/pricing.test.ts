import { estimateCost, readPricing, pricingMetadata } from '../src/lib/pricing';
import { MODEL_CATALOG } from '../src/lib/model-rates';
const rates = { 'claude-opus-5': { input: 5, output: 25, cacheRead: .5, cacheCreation: 6.25 } };
describe('API-equivalent pricing', () => {
  function withOverrides(value: string | undefined, work: () => void) {
    const previous=process.env.MODEL_RATES_JSON;
    if(value===undefined)delete process.env.MODEL_RATES_JSON;else process.env.MODEL_RATES_JSON=value;
    try{work();}finally{if(previous===undefined)delete process.env.MODEL_RATES_JSON;else process.env.MODEL_RATES_JSON=previous;}
  }
  test('all 20 published model rows and documented aliases have four usable default rates',()=>{
    withOverrides(undefined,()=>{
      const pricing=readPricing();expect(pricing.error).toBeNull();expect(MODEL_CATALOG).toHaveLength(20);
      for(const model of MODEL_CATALOG){
        for(const id of [model.id,...model.aliases]){
          const rows=['input','output','cacheRead','cacheCreation'].map(tokenType=>({_id:{model:id,tokenType},totalTokens:1000000}));
          expect(estimateCost(rows,pricing.rates).amount).toBeCloseTo(Object.values(model.rates).reduce((n,v)=>n+v,0),10);
        }
      }
      expect(pricingMetadata(pricing).catalog.every(m=>m.rates)).toBe(true);
    });
  });
  test('Haiku screenshot usage is priced and mixed-model costs add without losing Opus rates',()=>{
    withOverrides('{}',()=>{
      const rows=[{_id:{model:'claude-haiku-5-5',tokenType:'input'},totalTokens:29684},{_id:{model:'claude-haiku-5-5',tokenType:'output'},totalTokens:2701}];
      expect(estimateCost(rows,readPricing().rates).amount).toBeCloseTo(.0043189,10);
      expect(estimateCost([...rows,{_id:{model:'claude-opus-5',tokenType:'input'},totalTokens:1000000}],readPricing().rates).amount).toBeCloseTo(5.0043189,10);
      expect(pricingMetadata().basis).toContain('100,000');
      expect(pricingMetadata().catalog.find(m=>m.id==='claude-haiku-5-5')?.longPromptRates?.output).toBe(2.5);
    });
  });
  test('new cache-read discounts are model-specific; unknown versions never inherit them',()=>{
    withOverrides('{}',()=>{
      const p=readPricing();
      expect(p.rates['claude-opus-5-5'].cacheRead).toBe(.2);
      expect(p.rates['claude-sonnet-5-5'].cacheRead).toBe(.1);
      expect(p.rates['claude-fable-5-1'].cacheRead).toBe(.25);
      expect(estimateCost([{_id:{model:'claude-opus-99',tokenType:'input'},totalTokens:1}],p.rates).amount).toBeNull();
      expect(estimateCost([{_id:{model:'constructor',tokenType:'input'},totalTokens:1}],p.rates).amount).toBeNull();
    });
  });
  test('custom overrides merge with defaults and canonical changes propagate to known aliases',()=>{
    withOverrides(JSON.stringify({'claude-sonnet-4-5':{input:9,output:9,cacheRead:9,cacheCreation:9}}),()=>{
      const p=readPricing();expect(p.rates['claude-sonnet-4-5-20250929'].input).toBe(9);
      expect(p.rates['claude-haiku-5-5'].input).toBe(.1);
      expect(pricingMetadata(p).catalog.find(m=>m.id==='claude-sonnet-4-5')?.overridden).toBe(true);
    });
  });
  test('prices all four categories using rates per million tokens', () => {
    const rows = [['input',2],['output',14],['cacheRead',47715],['cacheCreation',49876]].map(([type,tokens]) => ({_id:{model:'claude-opus-5',tokenType:String(type)},totalTokens:Number(tokens)}));
    expect(estimateCost(rows,rates).amount).toBeCloseTo(.3359425,10);
  });
  test('unknown model makes the whole estimate unavailable, not zero', () => {
    expect(estimateCost([{_id:{model:'unpriced',tokenType:'input'},totalTokens:1000}],rates)).toEqual({amount:null,unpricedModels:['unpriced']});
  });
  test('one unpriced model prevents an incomplete total even alongside priced models', () => {
    expect(estimateCost([{_id:{model:'claude-opus-5',tokenType:'input'},totalTokens:1000},{_id:{model:'unknown',tokenType:'output'},totalTokens:10}],rates).amount).toBeNull();
  });
  test('empty data is unavailable and a recorded zero is a measured zero', () => {
    expect(estimateCost([],rates).amount).toBeNull();
    expect(estimateCost([{_id:{model:'claude-opus-5',tokenType:'input'},totalTokens:0}],rates).amount).toBe(0);
  });
  test('bad configuration cannot break token reporting', () => {
    const previous=process.env.MODEL_RATES_JSON;
    for (const bad of ['bad json','{"x":{"input":-1}}','{"x":{"input":"5","output":1,"cacheRead":1,"cacheCreation":1}}']) {
      process.env.MODEL_RATES_JSON=bad;expect(readPricing().error).not.toBeNull();expect(readPricing().rates).toEqual({});
    }
    if(previous===undefined)delete process.env.MODEL_RATES_JSON;else process.env.MODEL_RATES_JSON=previous;
  });
});
