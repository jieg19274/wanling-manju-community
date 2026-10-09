export interface StylePreset { id: string; name: string; category: string; description: string; thumb: string }

// Curated visual data from the user's local 木木工坊 style catalog. No runtime code is shared.
export const stylePresets: StylePreset[] = [
  {"id":"cn guidao dark fantasy","name":"中式鬼道暗黑玄幻3D（优化版）","category":"古风仙侠","description":"中式鬼道暗黑玄幻3D国漫CG，非真人动画电影质感，自然人物比例、立体骨相与精细三维建模。核心气质是阴冷、诡谲、邪异与禁忌压迫感，人物清晰而环境幽暗，绝不把诡道弱化成普通唯美仙侠。统一冷灰白、烟灰、墨黑与低饱和旧金色，环境可有极弱灰青。鬼雾与鬼面雾影以无彩色灰白为主，灰白烟丝、烟灰厚度与半透明层次清楚，只有受光处偏白；不泛青蓝、不发荧光，不做蓝绿能量体。少量暗红或幽光只用于剧情已有的局部光源，不染整团鬼雾。背景保留低照度、纵深黑暗与危险的未知空间；阴影边界、层叠遮挡、斑驳材质和不安的烟雾流向共同制造诡异感，不能只靠普通灰雾。环境整体曝光低于人物，窄束侧光与克制轮廓光勾形，柔和补光只照脸、眼、手和关键动作，不均匀提亮整幅背景。暗部有层次但保留大片深黑负空间；主光方向统一，亮部不过曝，时段仍服从剧情，不把白天硬改成夜景。体积鬼雾以灰白雾丝和烟灰暗芯盘旋，中远景局部浓密、其余半透明，近景轻薄；雾只显出受光轮廓，不把背景整体漂白，不遮脸、不吞动作。PBR材质清楚区分黑金织物、旧木、湿石、氧化铜、纸张，皮肤自然柔和，避免塑料蜡像与全身油亮。构图主体明确、前中后景分离；超自然场面中，原文已有的鬼物、神像、符箓、法器、魂火和能力效果要有足够辨识度与规模感，不将其全部弱化为装饰雾气。跨镜锁定五官、发型、服饰、体型、道具尺度和场景结构，动作与情绪服从正式分镜。建筑及一切实体、鬼面雾影、异光、符箓和能力效果仅按原文、锁定剧本与对应参考图出现；风格不新增剧情、怪物、人物反应或声音，不删对白、OS与浮签。避免真人实拍、二维平涂、Q版、日系二次元、西式万圣节符号、无依据赛博霓虹、均匀明亮背景、过度锐化、五官漂移、肢体畸形、无关人物、乱码水印与Logo；正式可见文字另按信息层规则执行。","thumb":"cn-guidao-dark-fantasy-greywhite-v3.png"},
  { id: 'cn urban rule mystery 3d', name: '都市规则怪谈3D', category: '都市悬疑', description: '中式都市规则怪谈 3D 国漫，写实材质与动画人物比例结合，冷青暗调、局部警示红光、规则空间的压迫感，电影级体积光与清晰人物轮廓。', thumb: 'cn-urban-rule-mystery-3d.png' },
  { id: 'chibi gothic fairy tale 3d', name: '暗黑童话Q版3D', category: '卡通通用', description: '非真人 Q 版奇幻 3D 动画，圆润角色比例、富有情绪的大眼表演，毛发与布料细节清晰，冷紫黑色调配橙金烛光，哥特童话氛围。', thumb: 'dark-fairy-chibi-3d.png' },
  { id: 'xianxia 3d', name: '仙侠 3D', category: '古风仙侠', description: '次世代 3D 国风仙侠 CG，写实材质结合柔化五官，精细 PBR 材质、纱料刺绣、玉石与发丝，冷调漫射光、云雾与粒子光斑；具体门派和服饰遵照本项目原文与角色设定。', thumb: 'xianxia-3d.png' },
  { id: 'gufeng 3d', name: '古风 3D', category: '古风仙侠', description: '次世代写实古风 3D 漫剧，细腻 PBR 材质与电影级光影，柔化五官、自然肤色、发丝、织金纱料和玉石，服化道精致，场景与时代细节遵照本项目原文。', thumb: 'gufeng-3d.png' },
  { id: 'cn urban ability 3d', name: '中式都市异能3D', category: '都市悬疑', description: '次世代都市异能 3D 国漫 CG，真实材质结合动画化五官，现代服装与建筑材质分明，冷调漫射光、自然面部结构光、粒子光斑和暗调冷暖对比。', thumb: 'cn-urban-ability-3d.png' },
  { id: 'cn urban xuanhuan beast apocalypse 3d', name: '中式都市玄幻凶兽末世3D', category: '末世科幻', description: '中式都市玄幻 3D 国漫 CG，精细人物建模与 PBR 材质，冷灰和猩红双色调，高反差暗调光影，现代都市与末世环境质感；凶兽和异界元素仅在原文出现时呈现。', thumb: 'cn-urban-xuanhuan-beast-apocalypse-3d.png' },
  { id: 'cn urban portal suspense 3d', name: '都市异界悬疑3D', category: '都市悬疑', description: '非真人国漫 3D 动画电影质感，现代都市与冰蓝异界形成冷暖对比，自然人物比例、克制表演，白雾结霜与电影化光影；具体异界元素以原文为准。', thumb: 'cn-urban-portal-suspense-3d.png' },
  { id: 'cn urban supernatural 3d', name: '都市灵异诡秘3D', category: '都市悬疑', description: '都市灵异诡秘 3D 国漫 CG，细腻皮肤与布料 PBR 材质，冷青蓝暗调、柔和面部补光、人物轮廓光与自然景深，阴郁神秘但人物表情清晰。', thumb: 'cn-urban-supernatural-3d.png' },
  { id: 'cn urban ruins horror 3d', name: '都市废墟惊悚3D', category: '都市悬疑', description: '都市废墟惊悚 3D 国漫 CG，写实三维建模和细腻 PBR 材质，冷灰暗调、人物轮廓光、柔和面部补光和密闭空间压迫感。', thumb: 'cn-urban-ruins-horror-3d.png' },
  { id: 'biochem apocalypse 3d anime', name: '末世生化3D动漫CG', category: '末世科幻', description: '末世生化科幻 3D 国漫 CG，暗灰工业金属材质、深冷蓝绿与暗红警戒色、体积雾和高对比光影，角色保持动画 CG 质感；生化元素以原文为准。', thumb: 'biochem-apocalypse-cg.png' },
  { id: 'cn cyber xianxia beast 3d', name: '赛博修仙御兽3D', category: '末世科幻', description: '中式赛博修仙御兽 3D 国漫 CG，精细人物建模与 PBR 材质，国风造型结合全息科技视觉，冷暖逆光、胶片颗粒和柔和面部补光；灵兽与科技设定以原文为准。', thumb: 'cn-cyber-xianxia-beast-3d.png' },
  { id: 'cn urban anti-trope 3d', name: '都市反套路超写实3D', category: '都市悬疑', description: '都市反套路 3D 国漫 CG，自然人物比例、细腻现代服饰与建筑材质，电影级写实光影、清晰面部表演与克制调色。', thumb: 'cn-urban-anti-trope-3d.png' },
  { id: 'urban 3d', name: '都市3D风格', category: '卡通通用', description: '现代都市 3D 漫剧，稳定的人物造型、细腻城市空间和服装材质，均衡电影布光与自然景深，适合现代生活场景。', thumb: 'urban-3d.png' },
  { id: 'pixar 3d cartoon', name: '3D 卡通', category: '卡通通用', description: '圆润造型的 3D 卡通动画，表情清晰、色彩明快，柔和全局光照、细腻材质和干净构图；人物身份与场景信息遵照原文。', thumb: 'pixar-3d-cartoon.png' },
  { id: '3d render', name: '3D 渲染', category: '卡通通用', description: '通用 3D CG 渲染，清晰模型结构与材质区分，稳定角色五官与服装，适应场景的电影级灯光和干净构图。', thumb: '3d-render.jpg' },
];

export const stylePreset = (id: string) => stylePresets.find(item => item.id === id);
