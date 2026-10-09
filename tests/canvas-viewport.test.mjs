import test from'node:test';import assert from'node:assert/strict';import{fitCanvasNodes,nodesInMarquee}from'../dist-server/shared/canvas-viewport.js';
test('marquee selects frames in either drag direction and excludes outside nodes',()=>{
 const nodes=[{id:'a',left:-50,top:0,width:100,height:100},{id:'b',left:100,top:100,width:100,height:100},{id:'c',left:500,top:500,width:100,height:100}];
 assert.deepEqual(nodesInMarquee(nodes,{x:220,y:220},{x:-20,y:-20}),['a','b']);assert.deepEqual(nodesInMarquee(nodes,{x:-20,y:-20},{x:220,y:220}),['a','b']);
 assert.deepEqual(nodesInMarquee(nodes,{x:300,y:300},{x:400,y:400}),[]);
});
test('fit includes dragged negative nodes and full node frames, not merely the grid',()=>{
 const nodes=[{left:-400,top:-100,width:205,height:215},{left:1800,top:650,width:245,height:185}],viewport={width:1200,height:850};const fit=fitCanvasNodes(nodes,viewport);assert.ok(fit);
 for(const n of nodes){assert.ok(n.left*fit.zoom+fit.offset.x>=49);assert.ok(n.top*fit.zoom+fit.offset.y>=69);assert.ok((n.left+n.width)*fit.zoom+fit.offset.x<=viewport.width-49);assert.ok((n.top+n.height)*fit.zoom+fit.offset.y<=viewport.height-69);}
 assert.ok(fit.zoom<1);
});
test('focus enlarges a selected media frame but remains bounded; invalid layout fails safely',()=>{
 assert.equal(fitCanvasNodes([{left:500,top:300,width:205,height:215}],{width:1200,height:850},2).zoom,2);
 assert.equal(fitCanvasNodes([],{width:1200,height:850}),undefined);assert.equal(fitCanvasNodes([{left:NaN,top:0,width:20,height:20}],{width:1200,height:850}),undefined);
});
