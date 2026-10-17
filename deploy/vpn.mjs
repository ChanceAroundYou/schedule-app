var a = await __cdp.eval('(async function(){try{var t0=Date.now();var r=await fetch("https://home.xiaokubao.space/schedule/api/health");var t=await r.text();return "OK "+r.status+" "+t.slice(0,40)+" in "+(Date.now()-t0)+"ms";}catch(e){return "ERR "+e.message+" after "+(Date.now()-t0)+"ms"}})()');
return a;
