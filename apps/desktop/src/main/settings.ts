/**
 * 应用设置的统一读写。
 *
 * 存在 userData/settings.json。刻意不把桥接密钥并进来——
 * 那是凭据，单独放一个文件更清楚，也避免备份设置时顺手泄露。
 */

import { app, screen } from 'electron';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export interface Settings {
  /** 悬浮标上次被拖到的位置。 */
  petPosition?: { x: number; y: number };
  /** 是否开机自启。默认关闭，由用户主动打开。 */
  launchAtLogin?: boolean;
  /**
   * 送达与完成时的庆祝动画。默认开。
   *
   * 给开关是因为这是个天天在用的常驻工具：同一段动画看第一百遍时，
   * 当初的惊喜会变成每次发消息都要等它演完的负担。
   */
  celebrations?: boolean;
}

const DEFAULTS: Settings = { celebrations: true };

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

let cache: Settings | null = null;

export function readSettings(): Settings {
  if (cache) return cache;
  const file = settingsPath();
  if (!existsSync(file)) {
    cache = { ...DEFAULTS };
    return cache;
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Settings;
    cache = { ...DEFAULTS, ...parsed };
  } catch (err) {
    // 文件被改坏了不能让应用起不来，退回默认值继续跑。
    console.warn('[设置] 解析失败，改用默认值：', err);
    cache = { ...DEFAULTS };
  }
  return cache;
}

export function patchSettings(patch: Partial<Settings>): void {
  const next = { ...readSettings(), ...patch };
  cache = next;
  try {
    writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    console.warn('[设置] 写入失败：', err);
  }
}

/**
 * 校验保存的位置现在是否还看得见。
 *
 * 换显示器、改分辨率、拔掉副屏之后，旧坐标可能落在任何屏幕之外。
 * 不校验就会出现「程序在跑但窗口找不到」这种最难自查的故障。
 * 只要窗口左上角落在某块屏幕的工作区内就算可见——不要求完全包含，
 * 否则贴边摆放的窗口会被误判。
 */
export function isPositionVisible(pos: { x: number; y: number }): boolean {
  return screen.getAllDisplays().some(({ workArea }) => {
    return (
      pos.x >= workArea.x &&
      pos.y >= workArea.y &&
      pos.x < workArea.x + workArea.width &&
      pos.y < workArea.y + workArea.height
    );
  });
}

/** 取可用的悬浮标位置；没存过或已不可见则返回 null，由调用方退回默认位置。 */
export function readPetPosition(): { x: number; y: number } | null {
  const pos = readSettings().petPosition;
  if (!pos) return null;
  if (!isPositionVisible(pos)) {
    console.warn('[设置] 保存的位置已不在任何屏幕内，退回默认位置');
    return null;
  }
  return pos;
}

/** 位置落盘。拖拽会连续触发 moved，调用方需自行去抖。 */
export function savePetPosition(pos: { x: number; y: number }): void {
  patchSettings({ petPosition: pos });
}

/**
 * 设置开机自启，并记进配置。
 *
 * dev 模式下不真的去动注册表：那样注册进去的是 electron.exe 加一串参数，
 * 开机根本起不来，还会在用户的启动项里留一条脏数据。
 */
export function setLaunchAtLogin(enabled: boolean): void {
  patchSettings({ launchAtLogin: enabled });
  if (!app.isPackaged) {
    console.log(`[设置] 开机自启已记为 ${enabled}（开发模式下不写入系统启动项）`);
    return;
  }
  app.setLoginItemSettings({ openAtLogin: enabled });
}

/**
 * 启动时把系统实际状态与配置对齐。
 * 用户可能在任务管理器的「启动」页里禁用过，那边是权威。
 */
export function syncLaunchAtLogin(): void {
  if (!app.isPackaged) return;
  const actual = app.getLoginItemSettings().openAtLogin;
  if (actual !== (readSettings().launchAtLogin === true)) {
    patchSettings({ launchAtLogin: actual });
  }
}
