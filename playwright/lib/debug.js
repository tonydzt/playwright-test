/**
 * 全局 debug 日志工具
 *
 * 通过 --debug 命令行参数或 DEBUG=1 环境变量启用。
 * 各模块通过 require('./debug') 使用。
 */

const enabled = process.argv.includes('--debug') || process.env.DEBUG === '1';

function debug(tag, ...args) {
  if (!enabled) return;
  const ts = new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
  console.log(`[DEBUG ${ts}] [${tag}]`, ...args);
}

debug.enabled = enabled;

module.exports = debug;
