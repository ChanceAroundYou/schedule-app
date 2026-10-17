var a = await __cdp.eval('(function(){var b=document.querySelector("[data-about=\\"check-update\\"]");if(!b)return "no btn";b.click();return "clicked";})()');
await __cdp.wait(2500);
return a;
