import {test} from 'node:test';
import assert from 'node:assert/strict';
import {presentCanvasNode,isFocusedConnection} from '../dist-server/shared/canvas-presentation.js';

test('changing canvas density preserves complete story, references and coordinates without changing the input',()=>{
  const node={id:'shot:locked',type:'shot',title:'正式分镜',content:'对白、OS、浮签与人物反应'.repeat(800),position:{x:1050,y:80},width:330,height:340,tags:['已锁定'],segmentId:'formal',artifactId:'full-prompt'};
  const before=JSON.stringify(node),overview=presentCanvasNode(node,'overview'),editing=presentCanvasNode(node,'editing');
  assert.ok(overview.height<editing.height);
  assert.deepEqual({...overview,height:node.height},node);
  assert.equal(JSON.stringify(node),before);
  assert.equal(presentCanvasNode(node,'overview',true),node,'manual dimensions take priority over density');
});

test('only connections touching a selected node are emphasized, including incoming and outgoing edges',()=>{
  const edge={id:'chosen',kind:'chosen',fromNodeId:'shot:1',toNodeId:'video:1'};
  assert.equal(isFocusedConnection(edge,new Set()),false);
  assert.equal(isFocusedConnection(edge,new Set(['unrelated'])),false);
  assert.equal(isFocusedConnection(edge,new Set(['shot:1'])),true);
  assert.equal(isFocusedConnection(edge,new Set(['video:1'])),true);
});
