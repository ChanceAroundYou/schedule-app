var a = await __cdp.eval('(async function(){try{var r=await fetch("https://www.baidu.com",{mode:"no-cors"});return "baidu OK "+r.type;}catch(e){return "baidu ERR "+e.message}})()');
var b = await __cdp.eval('(async function(){try{var r=await fetch("https://home.xiaokubao.space/schedule/api/health");return "home OK "+r.status;}catch(e){return "home ERR "+e.message}})()');
var c = await __cdp.eval('(async function(){try{var r=await fetch("http://192.168.1.6:25692/api/health");return "lanIP OK "+r.status;}catch(e){return "lanIP ERR "+e.message}})()');
return a + '\n' + b + '\n' + c;
