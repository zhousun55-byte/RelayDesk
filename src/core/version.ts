import fs from 'node:fs';
import path from 'node:path';

/** 接力台的版本号（package.json 里的）。编译后在 dist/src/core，往上三层是项目文件夹。 */
export const VERSION: string = (() => {
  try {
    return (JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return '?';
  }
})();
