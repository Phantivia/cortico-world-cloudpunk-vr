import type { ConfigGroup } from 'cortico/core/types.ts';

/** config.json 的 worlds.cloudpunk 段，默认禁用。 */
export interface CloudpunkConfigSection {
  enabled: boolean;
  /** 游戏内 CloudpunkVR 插件监听的 127.0.0.1 端口，与 BepInEx/config/palai.cloudpunkvr.cfg 的 [Coo] Port 一致。 */
  port: number;
  /** 装了 CloudpunkVR 的游戏副本里的 Cloudpunk.exe。 */
  gameExe: string;
  /** 从面板启动时带 -vrmode OpenVR。 */
  launchVr: boolean;
  /** VR 时游戏窗口给 OBS 的平稳第一人称画面(去掉头部抖动和侧倾，叠上游戏界面)。 */
  streamView: boolean;
  /** 自动驾驶的速度上限占游戏限速的比例。 */
  autopilotSpeed: number;
  /** 操作员自己开着导航路线时，前方转弯、升降和快到目的地都告诉可缇(像车载导航那样报)。 */
  navPrompts: boolean;
  corti: {
    /** 通讯框上的名字。 */
    name: string;
    /** Spout 发送端名;空 = 自动(VTube Studio 的，没有就取当前活动的)。 */
    sender: string;
    /** 方框里取画面的哪一块：放大倍数(1 = 整个画面高度)和中心位置(0..1,y 向上)。 */
    zoom: number;
    x: number;
    y: number;
    /** 上下翻转(发送端按顶行在前存图时要开)。 */
    flip: boolean;
    /** 套游戏 NPC 头像的全息材质(像素化、扫描线、撕裂噪点)。 */
    holo: boolean;
    inCar: boolean;
    /** 驾驶舱里可缇的全身从通讯屏上「出框」站起来，全息投影的样子(光锥、光环、光粒、照亮驾驶舱)。 */
    popOut: boolean;
    /** 出框全身取景的放大倍数(1 = 整个画面高度)，中心跟方框取景一样。 */
    popZoom: number;
    /** 出框全息的身高，米。 */
    popSize: number;
    /** 副驾驶座上坐一只可缇玩偶(3D,坐姿)。 */
    fufu: boolean;
    onFoot: boolean;
    onWrist: boolean;
    /** vtuber World 的 overlay 地址(/overlay 或 /stream),可缇的台词从这里来;空着时自动在本机找。 */
    subtitleUrl: string;
  };
  /** 直播间那层 overlay(OBS 叠在游戏上的浏览器源)搬进头显：一块跟头锁定的透明面板。 */
  overlay: {
    on: boolean;
    /** 各层的地址和摆放(JSON,见 mirror.ts 的 OverlayLayout);空 = 自动：先按 OBS 场景 obsScene 读，读不到就把本机找到的 overlay 铺满。 */
    layout: string;
    /** 照哪个 OBS 场景摆。 */
    obsScene: string;
    yaw: number;
    pitch: number;
    distance: number;
    width: number;
    opacity: number;
    /** 每层每秒最多推几帧给游戏。 */
    fps: number;
    /** 推给游戏的每层画面最宽多少像素。 */
    maxWidth: number;
    /** 无头浏览器;空 = 自动找 Edge,再找 Chrome。 */
    browser: string;
  };
}

export const CLOUDPUNK_DEFAULTS: CloudpunkConfigSection = {
  enabled: false,
  port: 47660,
  gameExe: 'G:\\Games\\CloudpunkVR\\Cloudpunk.exe',
  launchVr: true,
  streamView: true,
  autopilotSpeed: 0.85,
  navPrompts: true,
  corti: {
    name: '可缇',
    sender: '',
    zoom: 1.6,
    x: 0.5,
    y: 0.62,
    flip: true,
    holo: true,
    inCar: true,
    popOut: true,
    popZoom: 1,
    popSize: 0.3,
    fufu: true,
    onFoot: true,
    onWrist: true,
    subtitleUrl: 'http://127.0.0.1:7792/overlay',
  },
  overlay: {
    on: true,
    layout: '',
    obsScene: '云朋克直播间',
    // 和游戏界面面板差不多大、略近一点(画在它上面),稍低于视线
    yaw: 0,
    pitch: -3,
    distance: 1.5,
    width: 1.8,
    opacity: 1,
    fps: 8,
    maxWidth: 1280,
    browser: '',
  },
};

export const GROUP_GAME = 'world:cloudpunk';
export const GROUP_CORTI = 'world:cloudpunk:corti';
export const GROUP_OVERLAY = 'world:cloudpunk:overlay';

const P = 'worlds.cloudpunk';

export const CLOUDPUNK_CONFIG_GROUPS: ConfigGroup[] = [
  {
    id: GROUP_GAME,
    owner: 'world:cloudpunk',
    schema: {
      type: 'object',
      title: '游戏',
      properties: {
        [`${P}.gameExe`]: { type: 'string', title: '游戏程序', description: '装了 CloudpunkVR 的游戏副本里的 Cloudpunk.exe(Steam 要开着)。', 'x-path': { kind: 'file', extensions: ['.exe'] }, 'x-hot': true },
        [`${P}.launchVr`]: { type: 'boolean', title: '以 VR 启动', description: '开始时带 -vrmode OpenVR 启动游戏(SteamVR 要开着)。', 'x-hot': true },
        [`${P}.streamView`]: { type: 'boolean', title: '平稳直播画面', description: 'VR 时游戏窗口显示去掉抖动和侧倾的第一人称视角，叠上游戏界面;OBS 用游戏捕获抓 Cloudpunk 窗口，overlay 由 OBS 自己叠。关掉是头显左眼的原始镜像。', 'x-hot': true },
        [`${P}.autopilotSpeed`]: { type: 'number', minimum: 0.3, maximum: 1, title: '自动驾驶速度', description: '占游戏限速的比例。', 'x-hot': true },
        [`${P}.navPrompts`]: { type: 'boolean', title: '导航播报', description: '操作员自己开着导航路线时，前方转弯、升降和快到目的地都告诉可缇，像车载导航那样报。', 'x-hot': true },
        [`${P}.port`]: { type: 'integer', minimum: 1024, maximum: 65535, title: '插件端口', description: '须与游戏目录 BepInEx/config/palai.cloudpunkvr.cfg 的 [Coo] Port 一致。', 'x-hot': false },
      },
    },
  },
  {
    id: GROUP_CORTI,
    owner: 'world:cloudpunk',
    schema: {
      type: 'object',
      title: '可缇画面',
      description: 'VTube Studio 的 Spout2 输出显示在游戏的 NPC 通讯框里，台词来自 vtuber World。',
      properties: {
        [`${P}.corti.subtitleUrl`]: { type: 'string', title: '台词来源', description: 'vtuber World 的 overlay 地址(OBS 里那条，如 http://127.0.0.1:7792/overlay);空着时自动在本机找。', 'x-hot': true },
        [`${P}.corti.sender`]: { type: 'string', title: 'Spout 发送端', description: '留空自动找 VTube Studio 的。', 'x-hot': true },
        [`${P}.corti.name`]: { type: 'string', title: '通讯框名字', 'x-hot': true },
        [`${P}.corti.zoom`]: { type: 'number', minimum: 0.5, maximum: 6, title: '放大', description: '1 = 方框装下整个画面的高度。', 'x-hot': true },
        [`${P}.corti.x`]: { type: 'number', minimum: -0.5, maximum: 1.5, title: '取景中心 · 横', 'x-hot': true },
        [`${P}.corti.y`]: { type: 'number', minimum: -0.5, maximum: 1.5, title: '取景中心 · 竖', description: '0 在画面底边，1 在顶边。', 'x-hot': true },
        [`${P}.corti.flip`]: { type: 'boolean', title: '上下翻转', 'x-hot': true },
        [`${P}.corti.holo`]: { type: 'boolean', title: 'NPC 全息效果', description: '套游戏 NPC 头像的材质：像素化、扫描线、撕裂噪点。', 'x-hot': true },
        [`${P}.corti.inCar`]: { type: 'boolean', title: '驾驶舱通讯屏', description: '坐在驾驶舱里时显示在方向盘左边的通讯屏上。', 'x-hot': true },
        [`${P}.corti.popOut`]: { type: 'boolean', title: '驾驶舱出框全息', description: '坐在驾驶舱里时，可缇的全身从通讯屏上站起来，像全息投影那样悬浮(光锥、光环、光粒，照亮驾驶舱)。', 'x-hot': true },
        [`${P}.corti.popZoom`]: { type: 'number', minimum: 0.3, maximum: 4, title: '出框取景', description: '1 = 画面整个高度;中心跟方框取景一样。', 'x-hot': true },
        [`${P}.corti.popSize`]: { type: 'number', minimum: 0.1, maximum: 0.8, title: '出框身高', 'x-suffix': 'm', 'x-hot': true },
        [`${P}.corti.fufu`]: { type: 'boolean', title: '副驾驶玩偶', description: '驾驶舱的副驾驶座上坐一只可缇玩偶(3D,坐姿，随车晃动)。', 'x-hot': true },
        [`${P}.corti.onFoot`]: { type: 'boolean', title: '界面左下角', description: '步行和追尾视角时显示在游戏界面左下角(NPC 对话框的位置)。', 'x-hot': true },
        [`${P}.corti.onWrist`]: { type: 'boolean', title: '左手腕表', description: 'VR 步行时竖插在左前臂背上，像看手表那样抬手看。', 'x-hot': true },
      },
    },
  },
  {
    id: GROUP_OVERLAY,
    owner: 'world:cloudpunk',
    schema: {
      type: 'object',
      title: '直播 overlay',
      description: '直播间那层 overlay(OBS 叠在游戏上的浏览器源：可缇的演出层、直播间的写字板和弹幕、语音字幕)在无头浏览器里打开，原样搬进头显。',
      properties: {
        [`${P}.overlay.on`]: { type: 'boolean', title: '头显里显示', 'x-hot': true },
        [`${P}.overlay.obsScene`]: { type: 'string', title: '照哪个 OBS 场景摆', description: '读这个场景里可见的浏览器源和它们的位置、缩放;画布大小取当前 OBS 配置。', 'x-hot': true },
        [`${P}.overlay.layout`]: { type: 'string', title: '各层(JSON)', description: '留空自动：先按上面的 OBS 场景读，读不到就把本机找到的 overlay 铺满。面板上改开关会写到这里。', 'x-hot': true },
        [`${P}.overlay.yaw`]: { type: 'number', minimum: -60, maximum: 60, title: '左右', 'x-suffix': '°', 'x-hot': true },
        [`${P}.overlay.pitch`]: { type: 'number', minimum: -45, maximum: 45, title: '上下', 'x-suffix': '°', 'x-hot': true },
        [`${P}.overlay.distance`]: { type: 'number', minimum: 0.5, maximum: 5, title: '距离', 'x-suffix': 'm', 'x-hot': true },
        [`${P}.overlay.width`]: { type: 'number', minimum: 0.3, maximum: 6, title: '宽度', 'x-suffix': 'm', 'x-hot': true },
        [`${P}.overlay.opacity`]: { type: 'number', minimum: 0, maximum: 1, title: '不透明度', 'x-hot': true },
        [`${P}.overlay.fps`]: { type: 'integer', minimum: 1, maximum: 30, title: '帧率上限', description: '每层每秒最多推几帧给游戏。', 'x-hot': false },
        [`${P}.overlay.maxWidth`]: { type: 'integer', minimum: 480, maximum: 1920, title: '清晰度', description: '每层画面最宽多少像素;越大越清楚，游戏每帧上传越多。', 'x-suffix': 'px', 'x-hot': false },
        [`${P}.overlay.browser`]: { type: 'string', title: '无头浏览器', description: '留空自动找 Edge,再找 Chrome。', 'x-path': { kind: 'file', extensions: ['.exe'] }, 'x-hot': false },
      },
    },
  },
];
