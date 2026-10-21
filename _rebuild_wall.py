"""
壁纸重建 v2 —— 这次用**用户上传的原图**。

上一版的教训（写在这里，别再犯）：
  上一版以为"原图已不在磁盘"，于是拿已经压到 12~45KB 的 webp 做恢复性锐化。
  但原图一直都在 —— 用户上传的图存在 WorkBuddy 的 blob 库
  （C:/Users/lenovo/.workbuddy/blobs/<前2位>/<sha256>.jpg），按哈希分桶，
  按文件名根本搜不到。会话记录里每条用户消息的 input_image 都带 blob_path，
  从 projects/*.jsonl 里解析出来即可。**以后找不到素材先翻 jsonl，别下结论。**

本版做的三件事：
  1. 从 1920 宽的原始 JPEG 直接编码，不再从残图恢复；
  2. 把"颜色调整"烘焙进像素，运行时 CSS **完全不要 filter**：
     全屏滤镜 + 每帧移动的视差 = 每帧重跑一次全屏滤镜 pass，这是卡顿主因之一。
     烘焙之后默认状态零滤镜，视差只剩纯合成，最便宜。
  3. 饱和度统一回 1.0：原来每张图被 saturate(0.78~0.94) 压着，
     画面发灰，主观感受就是"不清晰"。亮度(bri)保留，因为它关系到浅色文字的可读性。
"""
import os
import shutil
from PIL import Image, ImageEnhance

WALL_DIR = 'public/static/img/wall'
THUMB_DIR = os.path.join(WALL_DIR, 'thumb')
BACKUP = '_diag/wall_v2'

# 顺序 = 用户上传的顺序（@image#1..#10 → 01..10）
BLOBS = [
    'ef3de3b1fb54da5142f76689d3ef6a0a32dead723ef1512309aa4450a9194565',
    'bc3326691b45c60d3c965c7a53f2f0d19960c771ecc8b48a800a658845be83f6',
    '5bfb724ddd8d3895c7d6cfc0fb40e69b83cd4fba0119dd89abd2f7ede843a42d',
    '7faa523de7d89d0c654eeff63495d21e90e3db06c924c186572e75d7199320f4',
    '47b734f2374df6d97a5e8729d837d81f049907b474ca018010760902ce47df5f',
    '811a5fc5bc0cfdbbd4e40f84d7866c0259b61a7695d07ceeb8e2db30acc42517',
    '2c2a9bb0948794bc8d3b551059b78e7d6053088796e55af4a7cfdea3fb257691',
    'a279c2f9325271ab7714b15e24412a1756e1d8e3d9cfa064bb60d6d61e89abdb',
    'd8af59323ec004cea3f0eafdb69ca1a7cf73d50ca79e7d9bb3e1b603845f9b67',
    '6cadf49b61ca10a7ae4e9af18df132fc244bbd3ef45f0447f8495352157eba47',
]
BLOB_ROOT = 'C:/Users/lenovo/.workbuddy/blobs'

# 亮度系数：全部 1.0，**不再压暗**。
#
# 上一版给暗色壁纸压到 0.88，理由是"浅色文字在亮部站不住"。但那是玻璃时代的思路：
# 当时文字直接浮在壁纸上有模糊层挡着，只能靠压暗底图保可读性。
# 现在全站是雾面实色（大容器 94%），文字都在实底卡片里，壁纸只负责氛围。
#
# 压暗的真实代价很硬：整图亮度降 12%，暗部细节被挤进黑场，
# 与原图的 PSNR 从 36dB 掉到 22dB —— 主观感受就是"糊、闷、不清晰"。
# 可读性交给 scrim 遮罩去管，底图保持原样。
BRI = {}   # 空 = 全部 1.0
SAT = 1.0  # 不压饱和度（原来最狠的一张被压到 0.5，画面发灰）

QUALITY = 92     # method=6 是 libwebp 最慢也压得最好的一档，离线构建值得等
THUMB_Q = 86
THUMB_W = 480


def main():
    os.makedirs(BACKUP, exist_ok=True)
    total_before = total_after = 0

    for i, h in enumerate(BLOBS, 1):
        src = os.path.join(BLOB_ROOT, h[:2], h + '.jpg')
        if not os.path.exists(src):
            print('!! 缺原图 ' + src)
            continue

        name = '%02d.webp' % i
        out = os.path.join(WALL_DIR, name)

        # 备份旧文件（只备份第一次，避免把处理结果当原图）
        bak = os.path.join(BACKUP, name)
        if os.path.exists(out) and not os.path.exists(bak):
            shutil.copy2(out, bak)
            total_before += os.path.getsize(bak)

        im = Image.open(src).convert('RGB')
        bri = BRI.get(i, 1.0)
        if bri != 1.0:
            im = ImageEnhance.Brightness(im).enhance(bri)
        if SAT != 1.0:
            im = ImageEnhance.Color(im).enhance(SAT)

        im.save(out, 'WEBP', quality=QUALITY, method=6)
        # 缩略图：LANCZOS 缩，尺寸不变（外观抽屉里的网格）
        th = int(im.height * THUMB_W / im.width)
        im.resize((THUMB_W, th), Image.LANCZOS).save(
            os.path.join(THUMB_DIR, name), 'WEBP', quality=THUMB_Q, method=6)

        size = os.path.getsize(out)
        total_after += size
        print('%02d  %dx%d  %6.0fKB  bri=%.2f' % (i, im.width, im.height, size / 1024, bri))

    print('\n壁纸合计 %.1fMB → %.1fMB' % (total_before / 1048576, total_after / 1048576))
    print('旧版备份在 ' + BACKUP)


if __name__ == '__main__':
    main()
