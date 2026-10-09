import type {StudioNode,StudioConnection} from './studio-canvas.js';
export type CanvasDensity='overview'|'editing';

/** Presentation only. Explicit user sizes and all authoritative fields survive. */
export function presentCanvasNode(node:StudioNode,density:CanvasDensity,manualSize=false):StudioNode {
  if(density==='editing'||manualSize)return node;
  const height=node.type==='shot'||node.type==='source'?215:node.type==='note'?185:node.type==='video'?250:235;
  return {...node,height:Math.min(node.height,height)};
}
export function isFocusedConnection(connection:StudioConnection,selected:ReadonlySet<string>):boolean {
  return selected.has(connection.fromNodeId)||selected.has(connection.toNodeId);
}
