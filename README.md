# cortico-world-cloudpunk-vr

[Cortico](https://github.com/Pal-AI-Lab/Cortico) 的 World(id `cloudpunk`,市场名「云朋克 Cloudpunk」):戴着头显玩 **Cloudpunk** 时，让 Coo(Cortico 的 Bot)坐进游戏里。
配套的游戏模组是 [CloudpunkVR](https://github.com/Phantivia/CloudpunkVR)(BepInEx 6 IL2CPP 插件)，World 经本机 TCP 和它对话。只支持 Windows。

做出来是给 VR 直播用的：主播戴头显玩，Coo 照常经 vtuber World 说话，同时接在游戏的通讯频道上，观众通过主播的视角看到 Coo 和 Coo 的台词。不直播也能用。

- **通讯频道**:VTube Studio 的 Spout2 画面显示在游戏给 NPC 通话用的方框里：驾驶舱里是方向盘左边的通讯屏，步行和追尾视角时在界面左下角，
  VR 步行时在左前臂背上的小屏。画面套着游戏 NPC 头像的材质(像素化、扫描线、撕裂)，正文是 Coo 正在说的那句，按发声时长逐字打出。
  NPC 来电或当面说话时频道让给 NPC,Coo 会收到一条被打断的事件(`cloudpunk.channel`)。Coo 的声音不经过这个 World。
- **头显里的直播 overlay**:OBS 叠在游戏画面上的浏览器源(演出层、弹幕、语音字幕)由 World 在无头 Edge(没有就用 Chrome)里打开、透明底截图，
  变了的那几层发给游戏，按 OBS 场景里的位置摆在一块跟头锁定的透明面板上。只在 VR 且开播时运行。
- **Coo 看得到游戏**:任务和地图标记的距离、屏幕上的对话(分通讯和当面)、获得物品的弹窗、教程提示、所在城区、车速油量和钱、面前能交互的东西。
- **车载领航**:按名字或种类搜游戏地图上的地点(商店、摊贩、加油站、车库、停车场、地名、任务点);路线沿城市的交通航线走到目标旁的停车位，
  画在小地图和全图上;任务在另一层时先导到升降梯。Coo 可以替玩家开过去(玩家一碰摇杆或扳机就交还)。玩家自己开时，偏离路线会重算，
  转弯、升降和快到目的地会提前告诉 Coo;油量低也会。
- **出框全息**:驾驶舱里 Coo 的全身从通讯屏上站出来，带投影光锥、脚下光环、上升光粒和一盏青色的光。
- **直播画面**:VR 时游戏窗口显示一路去抖的第一人称画面，叠着游戏界面，给 OBS 的游戏捕获用。

## 需要什么

- 一个能跑的 Cortico 部署(框架 0.2.4 或更新，World 契约 api 6),Node 22 以上。
- 装好 [CloudpunkVR](https://github.com/Phantivia/CloudpunkVR) 的游戏副本。
- 想要通讯频道里有画面：VTube Studio 和一个模型，打开 Spout2 输出。
- 想要台词跟着语音逐字出：[cortico-world-vtuber](https://github.com/Pal-AI-Lab/cortico-world-vtuber)。没有时方框里显示模型输出的文字。
- 想要头显里的直播 overlay:OBS,以及本机装着 Edge 或 Chrome。

## 安装

1. 按 [CloudpunkVR 的 README](https://github.com/Phantivia/CloudpunkVR#安装) 装好游戏副本。插件在 `127.0.0.1:47660` 听着
   (副本里 `BepInEx/config/palai.cloudpunkvr.cfg` 的 `[Coo]` 段)。
2. 从 [Releases](https://github.com/Phantivia/cortico-world-cloudpunk-vr/releases) 下载 `cortico-world-cloudpunk-vr-<版本>.tgz`,装进 Cortico 部署：

   ```bash
   cd <Cortico>/extensions && corepack pnpm add <下载的 tgz 的路径>
   ```

   或者在 WebUI 的「扩展 → 手动安装」里填这个 tgz 的路径。重启 Cortico,在 World 页启用「云朋克 Cloudpunk」(`worlds.cloudpunk`)。
3. 打开 World 页面的「游戏」页签，把「游戏程序」改成你的副本里的 `Cloudpunk.exe`(默认值是作者机器上的路径)。
4. VTube Studio:设置 → 摄像机 → 打开「Spout2 输出」,背景设成透明。笔记本有核显和独显时，在 Windows 的「显示卡」设置里把 VTube Studio 设成「高性能」:
   Spout 的共享贴图只能在创建它的那块显卡上打开，而游戏跑在独显上。
5. (直播用)OBS 开着、obs-websocket 打开且不设密码时，在 CloudpunkVR 的源码目录跑 `node tools/obs-scene.mjs <新场景名> <你现有的直播场景名>`:
   它新建一个场景，放一个 Cloudpunk 窗口的游戏捕获，再引用现有场景里的 overlay 和配音源。脚本里共享哪些源是按作者的场景写的
   (`SHARED` 那一行)，按你的源名改。不想用脚本就自己建：一个游戏捕获加上你的浏览器源。

直接从这个仓库的源码装要先打包面板：`corepack pnpm install && corepack pnpm build:webui`(生成 `dist/webui.js`),再 `pnpm add <这个目录>`。

## 使用

先开 Steam(Quest 先在 Virtual Desktop 里连上电脑)，然后在 World 页面的「开播」页签点**开始**。

| 页签 | 做什么 |
|---|---|
| 开播 | **开始**:游戏没开就启动它(是否 VR 看「游戏」页签)，让 Coo 上通讯频道，接上台词来源，打开 overlay 镜像。**收工**把这些撤下，游戏照常开着。连线表显示台词来源、overlay 镜像、Spout 画面和方框现在在哪。**自动查找地址**在本机找 vtuber World 的 overlay。测试按钮发一句假台词。 |
| 可缇画面 | 实时的 Spout 画面和方框取的那一块：拖动挪位置，滚轮缩放，或者在 VTube Studio 里挪模型。Spout 发送端、上下翻转、NPC 全息效果、方框显示在哪、名字、台词来源、出框全息和副驾驶玩偶的开关。 |
| 直播 overlay | 头显收到的那一层的预览;每层的开关和帧数;**照 OBS 场景摆**(读这里填的场景名)、**自动**(先读 OBS,没有就把本机找到的 overlay 铺满)、**重新打开页面**;距离、宽度、俯仰、偏航、不透明度。 |
| 游戏 | 游戏程序、是否以 VR 启动、去抖的直播画面、自动驾驶速度、Coo 看到的游戏状态。 |

设置页签里是同一批值，分三组(游戏、可缇画面、直播 overlay)。帧率、发送宽度和用哪个浏览器只在设置页签里有。

页签名和方框里的名字默认写的是「可缇」(作者直播里那位 Coo 的名字)，方框里的名字在「可缇画面」页签改。

台词来源填 vtuber World 的 overlay 地址(`http://127.0.0.1:<端口>/overlay`);World 读同源的 `/stream`(SSE),游戏自己逐字打出。
只在开播期间订阅：vtuber World 把演出流上有订阅者当作在播。副驾驶玩偶的模型没有随 CloudpunkVR 发布，怎么放自己的见那边的 README。

## 工具和事件

| 工具 | 做什么 |
|---|---|
| `cloudpunk_status` | 游戏现状的文字;`see: true` 附当前画面 |
| `cloudpunk_places` | 按名字或种类搜地图上的地点：编号、种类、距离、高度、方向 |
| `cloudpunk_navigate` | 规划到任务(默认是最近的带标记的)、`place: parking/car`、地点编号或地点名;`drive: true` 替玩家开过去或走过去 |
| `cloudpunk_stop` | 停下并清掉路线 |

事件：`cloudpunk.connection / live / channel / dialogue / quest / arrived / autopilot / place / mode / money / found / hint / fuel / route / interact`。
新任务、到达、油量低、转弯播报和 NPC 占线会唤醒模型;Coo 的台词还在屏幕上时 NPC 插进来，会打断这一轮。

## 开发

```bash
corepack pnpm install
corepack pnpm typecheck      # Node 侧和面板包
corepack pnpm test           # 对一个假插件走 TCP 协议、开播、假 SSE 上的台词、overlay 布局、频道事件、工具;测试不启动浏览器
corepack pnpm build:webui    # 重新生成 dist/webui.js
```

- `npx tsx scripts/live-check.ts <输出目录>` 对着正在跑的游戏检查：开播、一句台词、一张测试页的镜像、Spout 预览。
- 游戏里：插件的开发频道(`-cloudpunkvr-dev`)有 `live 1`、`cortisay`、`spout`、`spoutshot`、`wristbox`、`holofig`、`overlayinfo`、`places`、`navto`,
  见 CloudpunkVR 的 `docs/DEVELOPMENT.md`;那边的 `tools/spout-test-sender` 是一个发测试图案的 Spout 发送端，不开 VTube Studio 也能验接收。
- 协议：[`docs/protocol.md`](docs/protocol.md)。改了面板要升版本号：WebUI 按版本号缓存面板包。

## 许可

MIT
