/**
 * richText.test.ts —— 详细内容的「富文本 ⇄ 纯文本」换算
 *
 * 这层看着只是几个正则，但**它决定三处别的东西对不对**：搜索能不能搜到
 * 备注里的字、桌面小组件上会不会显示成一堆标签、冲突提示里那句话像不像人话。
 * 所以三件事各有一条断言。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { looksHtml, plain, toEditorHtml } from './model/richText.ts';

test('looksHtml：老数据（纯文本）不会被当成 HTML', () => {
  assert.equal(looksHtml('下月着手办 NMPA 2，需要一家内地公司'), false);
  assert.equal(looksHtml('1. 第一件事\n2. 第二件事'), false);
  assert.equal(looksHtml('a < b 这种纯文本里的尖括号'), false, '裸尖括号不算标签');
  assert.equal(looksHtml('<p>开会</p>'), true);
  assert.equal(looksHtml('前 <strong>后</strong>'), true);
});

test('plain：块级标签换成换行，标签本身消失', () => {
  assert.equal(plain('<p>第一段</p><p>第二段</p>'), '第一段\n第二段');
  assert.equal(plain('<ul><li>甲</li><li>乙</li></ul>'), '甲\n乙');
  assert.equal(plain('<h2>标题</h2><p>正文</p>'), '标题\n正文');
  assert.equal(plain('一行<br>两行'), '一行\n两行');
});

test('plain：空的段落不会留下大片空行', () => {
  const html = '<p>头</p><p></p><p></p><p></p><p>尾</p>';
  assert.equal(plain(html), '头\n\n尾', '三个以上换行压成两个');
});

test('plain：几类常见实体还原成人眼看的样子', () => {
  assert.equal(plain('<p>a &amp; b &lt;c&gt; d&nbsp;e</p>'), 'a & b <c> d e');
});

test('plain：纯文本原样返回，不被当成标签处理', () => {
  const s = '直接写的纯文本\n带换行';
  assert.equal(plain(s), s);
});

test('plain：富文本里带图片时，图片不产生垃圾字符', () => {
  /* img 是行内节点，不该塞换行 —— 关键断言是 **属性不会漏成文本**
     （漏了的话小组件上会出现 `src=/api/media/...` 这种鬼东西） */
  assert.equal(plain('<p>看图</p><img src="/api/media/x.webp" alt="现场"><p>说明</p>'), '看图\n说明');
});

test('toEditorHtml：纯文本按行切成段落，换行不丢', () => {
  assert.equal(toEditorHtml('第一行\n第二行'), '<p>第一行</p><p>第二行</p>');
  assert.equal(toEditorHtml('单行'), '<p>单行</p>');
  assert.equal(toEditorHtml(''), '');
});

test('toEditorHtml：纯文本里的尖括号要转义，不能被当成标签吃掉', () => {
  assert.equal(toEditorHtml('a < b'), '<p>a &lt; b</p>');
});

test('toEditorHtml：已经是 HTML 的原样返回，不二次包一层 p', () => {
  const html = '<p>已经是新格式</p>';
  assert.equal(toEditorHtml(html), html);
});
