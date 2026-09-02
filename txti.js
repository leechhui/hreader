#!/usr/bin/env node
'use strict';
/* ================================================================
 * txti.js —— 简读配套命令行工具（Node 18+，零依赖）
 *
 *   node txti.js clean   <文件或目录...> [--dry-run] [--out 目录]
 *       批量清理文本：移除每行首尾空白（含全角空格）、移除空行
 *   node txti.js encrypt <input.txt>  [-p 密码 | --password-env 变量] [-o 输出] [-n 书名]
 *       加密为 .txti（AES-256-GCM，密钥=SHA-256(密码)，nonce=前12字节）
 *   node txti.js decrypt <input.txti> [-p 密码 | --password-env 变量] [-o 输出]
 *       解密回 .txt
 *
 * 加密格式与「简读」阅读器完全一致；也可作为库使用：
 *   const { encryptTxt, decryptTxti, cleanText } = require('./txti.js');
 * ================================================================ */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const MAGIC = 'TXTIV1';
const NONCE_LEN = 12;

/* ---------- 文本与编码 ---------- */
function decodeBytes(data){
  if (data[0] === 0xEF && data[1] === 0xBB && data[2] === 0xBF) return data.subarray(3).toString('utf8');
  if (data[0] === 0xFF && data[1] === 0xFE) return data.subarray(2).toString('utf16le');
  if (data[0] === 0xFE && data[1] === 0xFF) return data.subarray(2).toString('utf16be');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(data); }
  catch (e) { return new TextDecoder('gb18030').decode(data); }
}
function readTextFile(p){ return decodeBytes(fs.readFileSync(p)); }
function cleanText(text){
  const src = String(text).replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  const lines = src.map(function(l){ return l.trim(); }).filter(function(l){ return l.length > 0; });
  return { text: lines.join('\n'), inLines: src.length, outLines: lines.length };
}

/* ---------- 加密 / 解密 ---------- */
function deriveKey(password){ return crypto.createHash('sha256').update(String(password), 'utf8').digest(); }
function md5(s){ return crypto.createHash('md5').update(String(s), 'utf8').digest('hex'); }
function buildPlaintext(content, name, version){
  name = String(name || '').replace(/[\r\n]/g, ' ').trim() || '未命名';
  content = String(content || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return Buffer.from(version + '\n' + name + '\n' + content, 'utf8');
}
function encryptTxt(content, name, password, version){
  const plaintext = buildPlaintext(content, name, version || MAGIC);
  const key = deriveKey(password);
  const nonce = crypto.randomBytes(NONCE_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ct, tag]);
}
function decryptTxti(data, password){
  data = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (data.length < NONCE_LEN + 16) throw new Error('文件过短，不是有效的 txti 文件');
  const nonce = data.subarray(0, NONCE_LEN);
  const tag = data.subarray(data.length - 16);
  const ct = data.subarray(NONCE_LEN, data.length - 16);
  const key = deriveKey(password);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  const text = plain.toString('utf8');
  const lines = text.split('\n');
  return { version: lines[0] || '', name: lines[1] || '', content: lines.slice(2).join('\n') };
}

/* ---------- 密码输入 ---------- */
function promptHidden(msg){
  return new Promise(function(resolve){
    if (!process.stdin.isTTY){
      const rl = readline.createInterface({ input: process.stdin });
      rl.question(msg, function(ans){ rl.close(); resolve(ans); });
      return;
    }
    process.stdout.write(msg);
    const stdin = process.stdin;
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let buf = '';
    const onData = function(ch){
      if (ch === '\u0003'){ process.exit(130); }
      else if (ch === '\r' || ch === '\n'){
        stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData);
        process.stdout.write('\n'); resolve(buf);
      } else if (ch === '\u0008' || ch === '\u007f'){ buf = buf.slice(0, -1); }
      else { buf += ch; }
    };
    stdin.on('data', onData);
  });
}
function getPassword(args){
  if (args['password-env']){
    const p = process.env[args['password-env']];
    if (!p){ console.error('环境变量 ' + args['password-env'] + ' 未设置'); process.exit(1); }
    return p;
  }
  if (args.password) return args.password;
  return promptHidden('密码：');
}

/* ---------- 参数解析 ---------- */
function parseArgs(argv){
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++){
    const a = argv[i];
    if (a === '-p' || a === '--password'){ args.password = argv[++i]; }
    else if (a === '--password-env'){ args['password-env'] = argv[++i]; }
    else if (a === '-o' || a === '--output'){ args.output = argv[++i]; }
    else if (a === '-n' || a === '--name'){ args.name = argv[++i]; }
    else if (a === '--out'){ args.out = argv[++i]; }
    else if (a === '--dry-run'){ args['dry-run'] = true; }
    else if (a === '-h' || a === '--help'){ args.help = true; }
    else if (a[0] === '-'){ /* 忽略未知旗标 */ }
    else { args._.push(a); }
  }
  return args;
}

/* ---------- 命令实现 ---------- */
function collectTxtFiles(paths){
  const out = [];
  function walk(p){
    const st = fs.statSync(p);
    if (st.isDirectory()){
      fs.readdirSync(p).forEach(function(name){ walk(path.join(p, name)); });
    } else if (/\.txt$/i.test(p)){
      out.push(p);
    }
  }
  paths.forEach(walk);
  return out;
}
async function cmdClean(args){
  const paths = args._;
  if (!paths.length){ console.error('用法：node txti.js clean <文件或目录...> [--dry-run] [--out 目录]'); process.exit(1); }
  const files = collectTxtFiles(paths);
  if (!files.length){ console.log('未找到 .txt 文件'); return; }
  let totalIn = 0, totalOut = 0, totalRemoved = 0;
  for (const p of files){
    const text = readTextFile(p);
    const r = cleanText(text);
    totalIn += text.length; totalOut += r.text.length; totalRemoved += (r.inLines - r.outLines);
    if (args['dry-run']){
      console.log('[预览] ' + p + '：' + r.inLines + ' 行 → ' + r.outLines + ' 行（删空行 ' + (r.inLines - r.outLines) + '）');
    } else if (args.out){
      const outPath = path.join(args.out, path.basename(p));
      fs.mkdirSync(args.out, { recursive: true });
      fs.writeFileSync(outPath, r.text, 'utf8');
      console.log('已清理 → ' + outPath + '（' + r.inLines + ' 行 → ' + r.outLines + ' 行）');
    } else {
      fs.writeFileSync(p, r.text, 'utf8');
      console.log('已清理 ' + p + '：' + r.inLines + ' 行 → ' + r.outLines + ' 行');
    }
  }
  if (!args['dry-run']) console.log('共 ' + files.length + ' 个文件：删空行 ' + totalRemoved + ' 行，' + totalIn + ' → ' + totalOut + ' 字符（输出统一 UTF-8）');
}
async function cmdEncrypt(args){
  const input = args._[0];
  if (!input){ console.error('用法：node txti.js encrypt <input.txt> [-p 密码] [-o 输出] [-n 书名]'); process.exit(1); }
  const password = await getPassword(args);
  const content = readTextFile(input);
  const name = args.name || path.basename(input).replace(/\.txt$/i, '');
  const data = encryptTxt(content, name, password);
  const out = args.output || (md5(content) + '.txti'); /* 文件名 = 内容 MD5 */
  fs.writeFileSync(out, data);
  console.log('已加密：' + input + ' → ' + out + '（' + data.length + ' 字节，书名：' + name + '）');
}
async function cmdDecrypt(args){
  const input = args._[0];
  if (!input){ console.error('用法：node txti.js decrypt <input.txti> [-p 密码] [-o 输出]'); process.exit(1); }
  const password = await getPassword(args);
  const data = fs.readFileSync(input);
  let r;
  try { r = decryptTxti(data, password); }
  catch (e){ console.error('解密失败：' + e.message + '（密码错误或文件损坏）'); process.exit(1); }
  const out = args.output || (path.basename(input).replace(/\.txti$/i, '') + '.txt');
  fs.writeFileSync(out, r.content, 'utf8');
  console.log('已解密：' + input + ' → ' + out + '\n版本：' + r.version + '\n书名：' + r.name);
}

const HELP = [
  '简读配套命令行工具（Node 18+，零依赖）',
  '',
  '  node txti.js clean   <文件或目录...> [--dry-run] [--out 目录]   批量清理：去行首尾空白、去空行',
  '  node txti.js encrypt <input.txt>  [-p 密码|--password-env 变量] [-o 输出] [-n 书名]',
  '  node txti.js decrypt <input.txti> [-p 密码|--password-env 变量] [-o 输出]',
  ''
].join('\n');

async function main(){
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._.shift();
  if (!cmd || args.help){ console.log(HELP); process.exit(0); }
  if (cmd === 'clean') await cmdClean(args);
  else if (cmd === 'encrypt') await cmdEncrypt(args);
  else if (cmd === 'decrypt') await cmdDecrypt(args);
  else { console.error('未知命令：' + cmd + '\n\n' + HELP); process.exit(1); }
}
if (require.main === module){ main(); }
else { module.exports = { MAGIC, NONCE_LEN, deriveKey, encryptTxt, decryptTxti, cleanText, decodeBytes, buildPlaintext }; }
