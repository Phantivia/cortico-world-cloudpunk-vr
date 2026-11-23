/** 包入口：默认导出 `WorldDefinition`,加载器按 `cortico.kind === 'world'` 认它。 */
import { CLOUDPUNK } from './definition.ts';

export default CLOUDPUNK;
export { CLOUDPUNK };
export type { CloudpunkConfigSection } from './config.ts';
