import {createInterface} from 'node:readline';
const base=`http://127.0.0.1:${Number(process.env.MANJU_PORT||5698)}`;
const schema=(properties:Record<string,unknown>,required:string[]=[])=>({type:'object',properties,required,additionalProperties:false});
const projectId={type:'string'},episodeId={type:'string'},workflowId={type:'string'};
const tools=[
  {name:'agent_connect',description:'识别万灵漫剧本机入口、制作默认规则、完整执行合同和可用命令，不读取密钥',inputSchema:schema({})},
  {name:'agent_context',description:'读取当前进度、完整原文、最新stateHash、授权额度和核验记录；修改前必读',inputSchema:schema({projectId,episodeId},['projectId'])},
  {name:'agent_readiness',description:'只检查本机软件、原文、模型配置、30秒能力与合成工具；不调用收费模型，不把配置完整当作真实模型连接成功',inputSchema:schema({projectId})},
  {name:'agent_dashboard',description:'轻量查询任务状态、各集当前步骤、剩余提交额度、交付文件与Agent核验记录；暂停任务只能在软件面板恢复',inputSchema:schema({projectId},['projectId'])},
  {name:'agent_create_project',description:'按稳定requestId创建项目，继承默认制作方案；重复请求复用项目',inputSchema:schema({requestId:{type:'string'},name:{type:'string'},mode:{type:'string',enum:['standard','douyin-story']},rules:{type:'object'}},['requestId','name'])},
  {name:'agent_task',description:'记录用户明确授予的本次集数、交付范围与生成额度；不从聊天推测费用授权，不将次数上限当作金额报价',inputSchema:schema({projectId,requestId:{type:'string'},agent:{type:'string'},statement:{type:'string'},confirmed:{type:'boolean'},episodeIds:{type:'array',items:{type:'string'}},delivery:{type:'string',enum:['package','video']},allowGeneration:{type:'boolean'},acceptUnknownCost:{type:'boolean'},limits:{type:'object'},maxAmount:{type:'number'},currency:{type:'string'}},['projectId','requestId','agent','statement','confirmed','episodeIds'])},
  {name:'agent_command',description:'按最新stateHash执行白名单草稿/核验动作或续跑工作流。审核需review具体证据，生成严格受taskId额度限制，结果未知不自动重提',inputSchema:schema({projectId,requestId:{type:'string'},expectedHash:{type:'string'},command:{type:'string',enum:['action','start','continue','pause','cancel','inspect','recover','revoke']},taskId:{type:'string'},episodeId,workflowId,segmentId:{type:'string'},artifactId:{type:'string'},jobId:{type:'string'},remote:{type:'boolean'},action:{type:'object'},review:{type:'object'}},['projectId','requestId','expectedHash','command'])},
  {name:'list_projects',description:'查询项目摘要，不读取密钥',inputSchema:schema({})},
  {name:'get_project',description:'读取原文、锁定剧本、资产和版本，供制作计划使用',inputSchema:schema({projectId},['projectId'])},
  {name:'audit_episode',description:'检查分集结构和五层核对状态，不代替用户放行',inputSchema:schema({projectId,episodeId},['projectId','episodeId'])},
  {name:'list_tasks',description:'查询任务，不重试未知计费请求',inputSchema:schema({projectId},['projectId'])},
  {name:'get_provider_billing',description:'读取模型单价、已确认的账户余额及密钥限额；无法确认来源时明确区分',inputSchema:schema({})},
  {name:'list_workflows',description:'查询持久化 Agent 流程、当前步骤、预算和暂停原因',inputSchema:schema({projectId},['projectId'])},
  {name:'start_workflow',description:'启动分集制作流程；付费步骤等待软件界面预算确认，复用已有审图审片',inputSchema:schema({projectId,episodeId,limits:{type:'object',properties:{text:{type:'integer',minimum:0,maximum:200},image:{type:'integer',minimum:0,maximum:200},video:{type:'integer',minimum:0,maximum:200}},additionalProperties:false}},['projectId','episodeId'])},
  {name:'control_workflow',description:'暂停、继续或取消流程；继续不授权新费用',inputSchema:schema({projectId,workflowId,operation:{type:'string',enum:['pause','resume','cancel']}},['projectId','workflowId','operation'])},
  {name:'save_source_draft',description:'保存未锁定分集的完整原文草稿；用户仍需阅读确认',inputSchema:schema({projectId,episodeId,sourceText:{type:'string',minLength:50,maxLength:1000000}},['projectId','episodeId','sourceText'])},
  {name:'save_visual_plan',description:'保存片段视觉与机位，不改锁定剧情；会使旧放行失效',inputSchema:schema({projectId,episodeId,segmentId:{type:'string'},visualPlan:{type:'string',minLength:1,maxLength:10000}},['projectId','episodeId','segmentId','visualPlan'])},
];
async function api(route:string,input?:unknown){const response=await fetch(base+route,{method:input===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(180000),headers:input===undefined?{}:{'Content-Type':'application/json'},...(input===undefined?{}:{body:JSON.stringify(input)})});const value=await response.json();if(!response.ok)throw Error(value.error||'软件接口失败');return value;}
async function call(name:string,args:Record<string,unknown>){
  const tool=tools.find(t=>t.name===name);if(!tool)throw Error('未知工具；请通过受任务额度约束的agent_command执行接管流程');
  for(const key of Object.keys(args))if(!(key in tool.inputSchema.properties))throw Error('未知参数 '+key);
  for(const key of tool.inputSchema.required)if(args[key]===undefined)throw Error('缺少参数 '+key);
  for(const key of ['projectId','episodeId','workflowId','segmentId'])if(args[key]!==undefined&&(typeof args[key]!=='string'||!/^[-a-zA-Z0-9]{1,100}$/.test(args[key] as string)))throw Error('ID无效');
  const project=`/api/projects/${args.projectId}`;
  if(name==='agent_connect')return api('/api/agent');
  if(name==='agent_context')return api(project+'/agent'+(args.episodeId?'?episodeId='+encodeURIComponent(String(args.episodeId)):''));
  if(name==='agent_readiness')return api('/api/agent/readiness'+(args.projectId?'?projectId='+encodeURIComponent(String(args.projectId)):''));
  if(name==='agent_dashboard')return api(project+'/agent/dashboard');
  if(name==='agent_create_project')return api('/api/agent/projects',args);
  if(name==='agent_task')return api(project+'/agent/task',args);
  if(name==='agent_command')return api(project+'/agent/command',args);
  if(name==='list_projects')return api('/api/projects');
  if(name==='get_provider_billing')return api('/api/direct-provider/billing');
  if(name==='get_project')return api(project);
  if(name==='audit_episode')return api(`${project}/episodes/${args.episodeId}/audit`);
  if(name==='list_tasks')return api(project+'/jobs');
  if(name==='list_workflows')return api(project+'/workflows');
  if(name==='start_workflow')return api(project+'/workflows',{episodeId:args.episodeId,limits:args.limits});
  if(name==='control_workflow'){if(!['pause','resume','cancel'].includes(String(args.operation)))throw Error('流程操作无效');return api(`${project}/workflows/${args.workflowId}/${args.operation}`,{});}
  if(name==='save_source_draft'){if(typeof args.sourceText!=='string'||args.sourceText.length<50||args.sourceText.length>1000000)throw Error('原文长度无效');return api(project+'/actions',{type:'episode.update',episodeId:args.episodeId,sourceText:args.sourceText});}
  if(name==='save_visual_plan'){if(typeof args.visualPlan!=='string'||!args.visualPlan.trim()||args.visualPlan.length>10000)throw Error('视觉计划无效');return api(project+'/actions',{type:'segment.update',episodeId:args.episodeId,segmentId:args.segmentId,visualPlan:args.visualPlan});}
}
const input=createInterface({input:process.stdin,crlfDelay:Infinity});
for await(const line of input){let message:{id?:string|number;method:string;params?:Record<string,any>}|undefined;
  try {if(line.length>2000000)throw Error('请求过大');message=JSON.parse(line);if(message?.id===undefined)continue;
    let result:unknown;
    if(message.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'wanling-manju',version:'0.3.0'}};
    else if(message.method==='ping')result={};
    else if(message.method==='tools/list')result={tools};
    else if(message.method==='tools/call'){const args=message.params?.arguments||{};if(typeof args!=='object'||Array.isArray(args))throw Error('参数格式无效');const value=await call(String(message.params?.name),args);result={content:[{type:'text',text:JSON.stringify(value)}]};}
    else throw Error('不支持的JSON-RPC方法');
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\n');
  } catch(error){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message?.id??null,error:{code:-32602,message:(error as Error).message}})+'\n');}
}
