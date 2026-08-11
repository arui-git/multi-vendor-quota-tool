import zhipu from './zhipu.mjs';
import opencode from './opencode.mjs';
import bailian from './bailian.mjs';
import volcano from './volcano.mjs';
import deepseek from './deepseek.mjs';

const REGISTRY = [zhipu, opencode, bailian, volcano, deepseek];

/** 返回各厂家元数据（不含可执行逻辑），供前端动态渲染表单 */
export function list() {
  return REGISTRY.map((p) => ({ id: p.id, name: p.name, fields: p.fields }));
}

/** 执行某厂家的额度查询，返回规范化结果；失败抛 Error */
export async function run(id, creds) {
  const p = REGISTRY.find((x) => x.id === id);
  if (!p) throw new Error('未知厂家: ' + id);
  return p.query(creds || {});
}