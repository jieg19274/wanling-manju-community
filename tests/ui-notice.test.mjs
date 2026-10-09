import {test} from 'node:test';
import assert from 'node:assert/strict';
import {noticeAutoDismissMs,renderAppNotice} from '../dist-server/shared/ui-notice.js';

test('completed operation feedback expires, including project and episode recycle messages',()=>{
  for(const message of ['项目“测试项目”已移入回收区，可在软件设置中恢复。','分集“第一集”已移入回收区，可在项目分集页恢复。','已导入：素材.mp4','项目已恢复。','项目风格已保存。'])assert.equal(noticeAutoDismissMs(message),6000);
});
test('failures and uncertain recovery instructions remain available instead of being mistaken for success',()=>{
  for(const message of ['操作失败：连接超时','API Key 已保存，但读取模型目录失败：连接错误','这是原确认号：查询/重传不会重复创建已预约候选。','已完成2批，服务中断，需要继续','原文文件超过 7 MB'])assert.equal(noticeAutoDismissMs(message),undefined);
});
test('notices have an accessible close action and escape operation text',()=>{
  assert.equal(renderAppNotice(''),'');
  const success=renderAppNotice('项目“<img src=x onerror=alert(1)>”已移入回收区');
  assert.ok(success.includes('&lt;img'));assert.ok(!success.includes('<img'));
  assert.ok(success.includes('data-app-notice'));assert.ok(success.includes('aria-label="关闭提示"'));assert.ok(success.includes('role="status"'));
  assert.ok(renderAppNotice('操作失败：连接超时').includes('role="alert"'));
});
