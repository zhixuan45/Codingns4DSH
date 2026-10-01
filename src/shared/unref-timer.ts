/**
 * 让长驻后台定时器不再持有事件循环。
 *
 * DSH 桌面端的更新器要求宿主在 10 秒内正常退出：只要进程里还有 ref 的定时器，
 * Node 就不会结束事件循环，更新会被判定为 `graceful deadline exceeded` 并中止。
 * 插件里的心跳、续期、刷新定时器只在宿主存活期间有意义，因此统一 unref：进程
 * 该退出时它们不再拦路，正常运行时行为不变。
 *
 * 浏览器里 `setInterval` 返回数字而不是 Timeout 对象，没有 `unref` 方法；
 * 可选调用让同一份代码在两条运行时上都安全。
 */
export function unrefTimer<T>(timer: T): T {
  (timer as T & { unref?: () => void }).unref?.()
  return timer
}
