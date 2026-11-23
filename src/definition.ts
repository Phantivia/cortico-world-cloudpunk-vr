import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { CLOUDPUNK_DEFAULTS, type CloudpunkConfigSection } from './config.ts';
import { CLOUDPUNK_TOOL_DECLS, CloudpunkWorld } from './world.ts';

export const CLOUDPUNK: WorldDefinition<CloudpunkConfigSection> = {
  id: 'cloudpunk',
  label: '云朋克',
  defaults: () => structuredClone(CLOUDPUNK_DEFAULTS),
  create: (ctx) => new CloudpunkWorld({ cfg: ctx.cfg, timezone: ctx.timezone, persist: (patch) => ctx.persist(patch) }),
  describe: {
    tools: describeTools(CLOUDPUNK_TOOL_DECLS, {
      cloudpunk_status: { zh: '看游戏现状：位置、车、钱、任务和标记距离、对话、可交互的东西、导航;可附画面。', en: 'Current game state: place, car, credits, quests and marker distances, dialogue, interactables, navigation; optionally the picture.' },
      cloudpunk_places: { zh: '搜地图上的地点：商店、加油站、停车场、地名、任务点;给编号、距离和方位。', en: 'Search the map: shops, gas stations, parking, named places, quest markers; ids, distance and direction.' },
      cloudpunk_navigate: { zh: '规划路线(任务、地点名或编号、停车位、回车上)并画在地图上，可替操作员开过去或走过去;操作员自己开时偏航重算、报转弯。', en: 'Plan a route drawn on the maps; optionally drive or walk it for the operator and park at the end.' },
      cloudpunk_stop: { zh: '停下自动驾驶或步行，清掉路线。', en: 'Stop driving or walking and clear the route.' },
    }),
    events: [
      { type: 'cloudpunk.connection', description: { zh: '游戏连上或断开。', en: 'Game connected or disconnected.' } },
      { type: 'cloudpunk.live', description: { zh: '操作员在面板上开播或收工。', en: 'The operator went on air or off air from the panel.' } },
      { type: 'cloudpunk.channel', description: { zh: 'NPC 接进或退出通讯频道(占线时可缇的画面和台词撤下)。', en: 'An NPC took or freed the call channel (the bot\'s picture and lines step aside meanwhile).' } },
      { type: 'cloudpunk.dialogue', description: { zh: '对话里的一句(说话人和台词)。', en: 'A dialogue line (speaker and text).' } },
      { type: 'cloudpunk.quest', description: { zh: '任务新增、更新或消失，附标记距离。', en: 'Quest added, updated or gone, with marker distance.' } },
      { type: 'cloudpunk.arrived', description: { zh: '导航到了(停好车或走到了)。', en: 'Navigation arrived (parked or walked there).' } },
      { type: 'cloudpunk.autopilot', description: { zh: '自动驾驶停下或交还操作员。', en: 'Autopilot stopped or handed back to the operator.' } },
      { type: 'cloudpunk.place', description: { zh: '进入新城区。', en: 'Entered a new district.' } },
      { type: 'cloudpunk.mode', description: { zh: '上下车、进出菜单和对话。', en: 'Got in or out of the car, menus, dialogue.' } },
      { type: 'cloudpunk.money', description: { zh: '信用点变化。', en: 'Credits changed.' } },
      { type: 'cloudpunk.found', description: { zh: '游戏弹出获得提示(物品、信用点、新地点)。', en: 'The game\'s pop-up for something received (item, credits, a new place).' } },
      { type: 'cloudpunk.hint', description: { zh: '屏幕上出现教程提示。', en: 'A tutorial hint came up.' } },
      { type: 'cloudpunk.fuel', description: { zh: '油量低于四分之一、十分之一。', en: 'Fuel under a quarter, then a tenth.' } },
      { type: 'cloudpunk.route', description: { zh: '导航播报：前方转弯、升降、快到目的地;偏航后重新规划。', en: 'Navigation prompts: turns, climbs and the destination ahead; a new route after leaving it.' } },
      { type: 'cloudpunk.interact', description: { zh: '面前出现可以交互的东西。', en: 'Something to interact with came up.' } },
    ],
  },
};
