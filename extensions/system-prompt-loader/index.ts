/**
 * index.ts — 根 entry（single-file entry 惯例，CA-2）。
 * 仓库 16 extensions 一致：package.json main/pi.extensions 指向本文件，Pi 直接执行 .ts 无 build。
 * re-export src/index.ts 的入口函数。
 */
export { default } from "./src/index.ts";
