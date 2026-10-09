import{test}from'node:test';import assert from'node:assert/strict';
test('preview catalog access allows only exact HTTPS GET models and cannot redirect into paid or upload endpoints',async()=>{
  const previous=globalThis.fetch,prior=process.env.MANJU_CATALOG_API_BASE_URL,calls=[];
  process.env.MANJU_CATALOG_API_BASE_URL='https://api.example.test/v1';
  globalThis.fetch=async(input,opts)=>(calls.push({input:String(input),opts}),{ok:true});
  try{await import('../scripts/catalog-readonly-guard.mjs');
    await fetch('https://api.example.test/v1/models?after=one',{redirect:'follow'});
    assert.equal(calls[0].opts.redirect,'manual');
    for(const [url,opts]of[['https://api.example.test/v1/models',{method:'POST'}],['https://api.example.test/v1/videos',{method:'POST'}],['https://api.example.test/v1/files',{method:'POST'}],['https://other.test/v1/models',{}],['http://api.example.test/v1/models',{}]])assert.throws(()=>fetch(url,opts),/已阻止/);
    assert.equal(calls.length,1);
  }finally{globalThis.fetch=previous;if(prior===undefined)delete process.env.MANJU_CATALOG_API_BASE_URL;else process.env.MANJU_CATALOG_API_BASE_URL=prior;}
});
test('approved result download follows only exact provider-issued read-only redirects without leaking credentials',async()=>{
  const previous=globalThis.fetch,profile=process.env.MANJU_BATCH_BUDGET_PROFILE,base=process.env.MANJU_APPROVED_BATCH_API_BASE_URL,calls=[];
  process.env.MANJU_BATCH_BUDGET_PROFILE='mock-profile';process.env.MANJU_APPROVED_BATCH_API_BASE_URL='https://api.mumugofe.com/v1';
  const signed='https://storage.example.test/result.mp4?signature=mock';
  globalThis.fetch=async(input,options)=>{calls.push({url:String(input),options});return String(input).endsWith('/content')?new Response(null,{status:302,headers:{location:signed}}):new Response('mock video');};
  try{
    await import('../scripts/catalog-readonly-guard.mjs?download-regression');
    assert.throws(()=>fetch(signed));
    await fetch('https://api.mumugofe.com/v1/videos/approved-task/content',{headers:{Authorization:'Bearer mock'}});
    assert.throws(()=>fetch(signed,{method:'POST'}));
    assert.throws(()=>fetch(signed,{headers:{Authorization:'Bearer mock'}}),/凭据/);
    assert.throws(()=>fetch('https://storage.example.test/other.mp4?signature=mock'));
    assert.equal(await(await fetch(signed)).text(),'mock video');
    assert.equal(calls.length,2);assert.equal(calls[1].options.redirect,'manual');
    assert.throws(()=>fetch(signed));
  }finally{globalThis.fetch=previous;for(const [key,value]of [['MANJU_BATCH_BUDGET_PROFILE',profile],['MANJU_APPROVED_BATCH_API_BASE_URL',base]])if(value===undefined)delete process.env[key];else process.env[key]=value;}
});
