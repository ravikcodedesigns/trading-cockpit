// rs-find — ONE-SHOT, READ-ONLY. Hunt the loaded page for specific values.
// Passive: single Runtime.evaluate, no writes/clicks/navigation/network originated.
//   node scripts/rs-find.js
const http = require('http');
const WS = require('/Users/ravikumarbasker/trading-cockpit/node_modules/.pnpm/ws@8.20.0/node_modules/ws');
const PORT = process.env.CDP_PORT || '9333';

const EXPR = `(function(){
  var MT=(window.top&&window.top.MASTER_TABLE)||window.MASTER_TABLE;
  if(!MT) return JSON.stringify({err:'no MASTER_TABLE'});
  var out={mtKeys:Object.keys(MT), dataKeys:MT.data?Object.keys(MT.data):null, syms:{}};
  ['QQQ','SPY','IWM'].forEach(function(s){
    var o=MT.data&&MT.data[s]; if(!o) return;
    var scal={}, fields={};
    Object.keys(o).forEach(function(k){ var v=o[k];
      if(v&&typeof v==='object'){ fields[k]=Array.isArray(v)?('Array['+v.length+']'):('Obj{'+Object.keys(v).slice(0,10).join(',')+'}'); }
      else scal[k]=v;
    });
    // dominant walls: top call & top put by gamma-ish magnitude, for HP and MHP ladders
    function dominant(arr){ if(!Array.isArray(arr)) return null;
      var bc=null,bp=null;
      arr.forEach(function(r){ if(!r)return; var st=parseFloat(r.strike);
        if(r.call!=null && (bc==null||Math.abs(r.call)>Math.abs(bc.v))) bc={strike:st,v:r.call};
        if(r.put!=null && (bp==null||Math.abs(r.put)>Math.abs(bp.v))) bp={strike:st,v:r.put};
      });
      return {topCall:bc, topPut:bp, n:arr.length, sample:arr.slice(0,2)};
    }
    out.syms[s]={scalars:scal, fields:fields, domMHP:dominant(o.man_MHP_walls), domHP:dominant(o.man_HP_walls)};
  });
  return JSON.stringify(out);
})()`;

http.get(`http://localhost:${PORT}/json`, res => { let b=''; res.on('data',d=>b+=d); res.on('end',()=>{
  let tab; try{ const pp=JSON.parse(b).filter(t=>t.type==='page'&&(t.url||'').includes('rocket.place/pro-plus'));
    tab=pp.find(t=>/\/pro-plus\/?($|[?#])/.test(t.url))||pp.find(t=>!/\/(settings|account|pricing|dashboard)/.test(t.url))||pp[0]; }catch(e){ console.error('list',e.message); process.exit(1); }
  if(!tab){ console.error('no pro-plus tab'); process.exit(1); }
  const ws=new WS(tab.webSocketDebuggerUrl,{maxPayload:50*1024*1024});
  const to=setTimeout(()=>{console.error('timeout');process.exit(1);},12000);
  ws.on('open',()=>ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:EXPR,returnByValue:true}})));
  ws.on('message',m=>{const msg=JSON.parse(m);if(msg.id===1){clearTimeout(to);try{ws.close();}catch{};
    if(msg.result&&msg.result.exceptionDetails){console.error('eval error',JSON.stringify(msg.result.exceptionDetails).slice(0,500));process.exit(1);}
    console.log(JSON.stringify(JSON.parse(msg.result.result.value),null,2));process.exit(0);}});
  ws.on('error',e=>{clearTimeout(to);console.error('ws',e.message);process.exit(1);});
});}).on('error',e=>{console.error('http',e.message);process.exit(1);});
