import { copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const output = join(root, 'dist', 'demo');

function sampleAttribute(name) {
  const value = process.env[`BIAI_DEMO_SAMPLE_${name.toUpperCase()}_URL`];
  if (!value) return '';
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('示例素材须使用公开的 HTTPS 直链。');
  return ` data-sample-${name}="${url.href.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"`;
}

const template = await readFile(join(root, 'web', 'index.html'), 'utf8');
const html = template.replace('<html lang="zh-CN">', `<html lang="zh-CN" data-public-demo="true"${sampleAttribute('video')}${sampleAttribute('cover')}>`)
  .replace('href="/styles.css"', 'href="./styles.css"').replace('src="/app.js"', 'src="./app.js"');
await mkdir(output, { recursive: true });
await Promise.all([
  writeFile(join(output, 'index.html'), html),
  ...['app.js', 'styles.css', 'demo.js'].map(file => copyFile(join(root, 'web', file), join(output, file))),
  copyFile(join(root, 'mock.mjs'), join(output, 'mock.js')),
  copyFile(join(root, 'generation-models.js'), join(output, 'generation-models.js')),
  copyFile(join(root, 'LICENSE'), join(output, 'LICENSE')),
  cp(join(root, 'web', 'demo-assets'), join(output, 'demo-assets'), { recursive: true })
]);
console.log(`Public demo: ${output}`);
