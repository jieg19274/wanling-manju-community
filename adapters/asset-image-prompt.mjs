export function assetImagePrompt(task, hasReferences = false) {
  const asset = task.asset || {};
  const instruction = task.instruction || '';
  const role = asset.referenceRole || task.referenceRole ||
    (/^只生成[^\n]*四视图/.test(instruction) ? 'turnaround' : 'main');
  const character = asset.kind === 'character' && !(/第一人称|POV/iu.test(asset.identity || '') && /不展示正脸|不露正脸|禁止正脸/u.test(asset.identity || '') && /手|衣袖/u.test(asset.identity || ''));
  if(character && role !== 'turnaround')throw new Error('人物参考统一使用完整四视图＋大头照');
  const framing = role === 'turnaround'
    ? '本任务要求完整四视图＋大头照：横向依次正面完整全身、90°侧面完整全身、背面完整全身、正面大头近照；第四格脸或动物头部至少占60%，不是45°全身图。同一身份、发型、衣着、配色、数量与当前形态，无文字标注。整张图用于固定角色一致性，保留全部视角，不裁切拆图。'
    : '仅一幅连续画面、一个视角。禁止多视图设定表、拼图、分格、重复角度、小窗、局部放大插图或同一对象的重复副本。';
  const background = asset.kind === 'scene'
    ? '场景图保留身份和当前状态明确规定的地形、建筑、固定陈设及空间关系。无临时演员或剧情动作；不得添城楼、长墙、灯具、栏杆等未登记结构，也不得删除已经登记的结构。'
    : asset.kind === 'prop'
      ? '道具图：仅登记的道具及明确必要的一组组成，完整轮廓，均匀中性灰色空背景和自然落影。不得自行添加桌台、房间、宫殿、箱子、手、其他道具或展示架；道具自身为桌椅时仍须独立展示。'
      : '角色图：均匀中性灰色空背景，完整展示所要求形态。' + (asset.state
        ? '姿态及持物按当前状态；死亡状态不得改为活人站姿。'
        : '基础图用自然中性姿态：人形双臂自然下垂、双手空、嘴自然闭；动物保持自然形态。资产名称中的“发问、挑拨、喊话、领赏”等只是索引，不是要在基础图表演的动作。') + '无额外演员、场景或未登记的持物。';
  const referenceNotes = hasReferences ? [
    '附图按下列用途提供，不能把参考图中的全部内容都当成正确或都当成同一资产。没有明确审核标记的附图不称为已审核。',
    ...(task.references || []).map((ref, index) => `附图${index + 1}：${ref.promptUse || '外形或构图参考；只继承与目标身份、当前状态及本次修正一致的部分。'}`),
    '待修正原图仅保留明确正确部分，指定错误必须消除；其他资产的参考仅用于所标明的共用或内含结构。较早状态参考用于脸、骨相、花纹或结构连续性，不得覆盖当前衣着、健康、伤势、成年阶段、数量或建造进度。',
  ] : [];
  // An opt-in, source-checked visual extraction keeps nonvisual biography and
  // future events in the native request, without asking the image to enact them.
  // Identity and state objects themselves remain intact in the adapter snapshot.
  if (task.visualRenderBrief) {
    const brief = task.visualRenderBrief;
    if (!brief.sourceHash || !brief.scriptHash || !brief.identityHash ||
        (asset.state && !brief.stateHash) || typeof brief.text !== 'string' || !brief.text.trim()) {
      throw new Error('A source-locked visual brief requires complete authority fingerprints');
    }
    return [
      `项目风格：${task.visualStyle?.description || ''}`,
      `${asset.kind || 'asset'}：${asset.name || ''}`,
      `当前可见外观：${brief.text}`,
      framing,
      background,
      '单幅参考无标题、标注、水印或伪字。',
      ...referenceNotes,
      '本次渲染要求：',
      instruction,
    ].join('\n');
  }
  return [
    `项目风格：${task.visualStyle?.description || ''}`,
    `${asset.kind || 'asset'}：${asset.name || ''}`,
    '以下登记文本完整保留。它可能包含初见状态及后续使用说明，并非要求把不同时间点同时画进一张图。',
    `登记身份与基础外观：${asset.identity || ''}`,
    asset.state ? `当前剧情状态：${asset.state.label}；${asset.state.appearance}` : '基础状态',
    asset.state
      ? '时间优先级：只画当前剧情状态。当前明确改变的健康、年龄阶段、伤势、服装、数量、姿态、束缚、持物及建造进度覆盖初见描述；保持未改变的同一身份、脸、骨相、花纹和结构。不提前画下一状态，不退回旧状态。当前称“沿此前、同前、持续”的衣着、旧伤和束缚须继承指定上一状态，不能因基础站姿而把绑椅者画成自由站立。'
      : '只画登记的基础状态，不提前加入登记文本中另一个时点才发生的伤势、动作、展开或建造变化。',
    '数量以当前状态明确数量为准；没有状态时以登记身份明确数量为准。角色资产可以是一组动物，不得把四只或七只强行画成一只。“一个视角”不改变目标数量。',
    '按每件、每捆、每组理解计量关系：“每捆十株”指一捆内有十株，不是画十捆。道具说明中的“另配、独立道具、不烙入”必须落实，不能把竹篓、包等一起固化到当前对象。',
    framing,
    background,
    '这张资产参考不增加标题、标注、水印或伪字。参考图中无可读字的要求只适用于此图；正式剧情的对白、内心OS、浮签、系统信息及规定的物体刻字仍完整保留在正式制作中。',
    ...referenceNotes,
    '本次图片参考的渲染与修正要求（完整执行；不替代或删除正式剧本内容）：',
    instruction,
  ].join('\n');
}
