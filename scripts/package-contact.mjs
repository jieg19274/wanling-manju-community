import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const qrSource = fileURLToPath(new URL('../assets/release/contact-wechat.jpg', import.meta.url));

export function includePackageContact(target) {
  fs.copyFileSync(qrSource, path.join(target, '微信联系二维码.jpg'));
  fs.writeFileSync(path.join(target, '联系与反馈.md'),
    '# 联系与反馈\n\n使用交流或反馈问题，可扫描下方微信二维码添加好友。\n\n' +
    '![微信联系二维码](微信联系二维码.jpg)\n\n' +
    '如果阅读器无法显示图片，直接打开本目录的“微信联系二维码.jpg”。\n');
}
