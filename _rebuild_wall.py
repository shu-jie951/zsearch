# -*- coding: utf-8 -*-
"""
壁纸高清化重建。

背景：原来的 10 张 webp 被压到 12~45KB（1920 宽），100% 裁切能看到明显的
块状色带和压缩噪点。原始高清图已经不在磁盘上，所以这里做的是**恢复性处理**，
不是"换一张更清楚的图"：

  1) 解码原 webp（不能凭空造出细节，只能在既有像素上做修复）
  2) 保守锐化：只锐化明显边缘（threshold 抬高），平坦区域不动。
     为什么必须抬高 threshold —— 低 threshold 会把 JPEG/WebP 的块效应
     当成边缘一起锐化，结果是"更锐但更脏"。
  3) 以 q=92 / method=6 重新编码。method=6 是 libwebp 最慢但压缩率最高的档，
     离线构建用得上，运行时无代价。
  4) 缩略图同源重建（外观抽屉里的预览，480 宽够用）

用法: python _rebuild_wall.py
"""
import os
import sys
import shutil
from PIL import Image, ImageFilter

WALL_DIR = os.path.join('public', 'static', 'img', 'wall')
THUMB_DIR = os.path.join(WALL_DIR, 'thumb')
BACKUP = '_diag/wall_originals'


def main():
    files = sorted(f for f in os.listdir(WALL_DIR) if f.lower().endswith('.webp'))
    if not files:
        print('没找到壁纸，路径对吗？', WALL_DIR)
        return 1

    os.makedirs(BACKUP, exist_ok=True)
    os.makedirs(THUMB_DIR, exist_ok=True)

    total_before = 0
    total_after = 0

    for name in files:
        path = os.path.join(WALL_DIR, name)
        before = os.path.getsize(path)
        total_before += before

        # 备份原文件（只备份第一次，别让第二次运行把已处理的结果当原图）
        bak = os.path.join(BACKUP, name)
        if not os.path.exists(bak):
            shutil.copy2(path, bak)

        src = Image.open(bak).convert('RGB')
        w, h = src.size

        # 保守锐化：radius 1.0 只作用于最近邻像素，threshold 6 放过低对比差异
        # （块效应正是低对比差异，放过它才不会越锐越脏）
        sharp = src.filter(ImageFilter.UnsharpMask(radius=1.0, percent=48, threshold=6))

        sharp.save(path, 'WEBP', quality=92, method=6)

        # 缩略图：480 宽，q=84
        tw = 480
        th = max(1, round(h * tw / w))
        sharp.resize((tw, th), Image.LANCZOS).save(
            os.path.join(THUMB_DIR, name), 'WEBP', quality=84, method=6
        )

        after = os.path.getsize(path)
        total_after += after
        print('  %-10s %dx%d  %5dKB -> %5dKB  (%.1fx)' % (
            name, w, h, before // 1024, after // 1024, after / before))

    print('')
    print('合计: %.1fMB -> %.1fMB' % (total_before / 1048576, total_after / 1048576))
    return 0


if __name__ == '__main__':
    sys.exit(main())
