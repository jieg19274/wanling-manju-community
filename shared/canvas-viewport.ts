export type CanvasBounds={left:number;top:number;width:number;height:number};
export function nodesInMarquee(nodes:(CanvasBounds&{id:string})[],a:{x:number;y:number},b:{x:number;y:number}){
 const left=Math.min(a.x,b.x),right=Math.max(a.x,b.x),top=Math.min(a.y,b.y),bottom=Math.max(a.y,b.y);
 return nodes.filter(n=>n.left<right&&n.left+n.width>left&&n.top<bottom&&n.top+n.height>top).map(n=>n.id);
}
export function fitCanvasNodes(nodes:CanvasBounds[],viewport:{width:number;height:number},maximum=1.5){
  if(!nodes.length||viewport.width<=100||viewport.height<=140||nodes.some(n=>![n.left,n.top,n.width,n.height].every(Number.isFinite)||n.width<=0||n.height<=0))return undefined;
  const left=Math.min(...nodes.map(n=>n.left)),top=Math.min(...nodes.map(n=>n.top));
  const right=Math.max(...nodes.map(n=>n.left+n.width)),bottom=Math.max(...nodes.map(n=>n.top+n.height));
  const zoom=Math.max(.1,Math.min(maximum,(viewport.width-100)/(right-left),(viewport.height-140)/(bottom-top)));
  return{zoom,offset:{x:(viewport.width-(right-left)*zoom)/2-left*zoom,y:(viewport.height-(bottom-top)*zoom)/2-top*zoom}};
}
