# -*- coding: utf-8 -*-
"""
壁纸清晰度实测（像素层）。

断言"清晰"不能靠嘴说，也不能只看文件大小。这里用两个客观指标：

  1. 拉普拉斯方差 —— 经典的锐度/细节量指标。对同一张图，数值越高细节越多。
     注意它会被亮度整体缩放影响，所以同时输出亮度均值，避免把"提亮"误读成"变锐"。

  2. 与原始 JPEG 的 PSNR —— 直接回答"离原图有多远"。
     新版是从原图按 q=92 编码的，应该与原图几乎一致；
     旧版是从残图二次压缩来的，PSNR 会明显更低。

三档样本：
  A. _diag/wall_originals/  —— 最初那版（12~45KB，用户说"不清晰"的就是它）
  B. _diag/wall_v2/         —— 上一轮（从残图恢复性锐化，1920 宽）
  C. public/static/img/wall/—— 本轮（从原图直接编码，调色烘焙进像素）
"""
import io
import os
import sys
import numpy as np
from PIL import Image

BLOB_ROOT = 'C:/Users/lenovo/.workbuddy/blobs'
BLOBS = {
    1: 'ef3de3b1fb54da5142f76689d3ef6a0a32dead723ef1512309aa4450a9194565',
    2: 'bc3326691b45c60d3c965c7a53f2f0d19960c771ecc8b48a800a658845be83f6',
    3: '5bfb724ddd8d3895c7d6cfc0fb40e69b83cd4fba0119dd89abd2f7ede843a42d',
    4: '7faa523de7d89d0c654eeff63495d21e90e3db06c924c186572e75d7199320f4',
    5: '47b734f2374df6d97a5e8729d837d81f049907b474ca018010760902ce47df5f',
    6: '811a5fc5bc0cfdbbd4e40f84d7866c0259b61a7695d07ceeb8e2db30acc42517',
    7: '2c2a9bb0948794bc8d3b551059b78e7d6053088796e55af4a7cfdea3fb257691',
    8: 'a279c2f9325271ab7714b15e24412a1756e1d8e3d9cfa064bb60d6d61e89abdb',
    9: 'd8af59323ec004cea3f0eafdb69ca1a7cf73d50ca79e7d9bb3e1b603845f9b67',
    10: '6cadf49b61ca10a7ae4e9af18df132fc244bbd3ef45f0447f8495352157eba47',
}

LAP_KERNEL = np.array([[0, 1, 0], [1, -4, 1], [0, 1, 0]], dtype=np.float64)


def gray(a):
    return a[..., 0] * 0.299 + a[..., 1] * 0.587 + a[..., 2] * 0.114


def laplacian_var(im):
    """锐度：拉普拉斯响应的方差。"""
    g = gray(np.asarray(im, dtype=np.float64))
    # 手写 3x3 卷积，避免依赖 scipy
    h, w = g.shape
    out = np.zeros((h - 2, w - 2), dtype=np.float64)
    for dy in range(3):
        for dx in range(3):
            k = LAP_KERNEL[dy, dx]
            if k:
                out += k * g[dy:h - 2 + dy, dx:w - 2 + dx]
    return float(out.var())


def psnr(a, b):
    """与原图的峰值信噪比（dB）。a/b 均已缩放到同一尺寸。"""
    x = np.asarray(a, dtype=np.float64)
    y = np.asarray(b, dtype=np.float64)
    mse = float(np.mean((x - y) ** 2))
    if mse <= 1e-9:
        return 99.0
    return 10 * np.log10((255.0 ** 2) / mse)


def load(p):
    return Image.open(p).convert('RGB')


def main():
    rows = []
    for i in sorted(BLOBS):
        name = '%02d.webp' % i
        src_path = os.path.join(BLOB_ROOT, BLOBS[i][:2], BLOBS[i] + '.jpg')
        if not os.path.exists(src_path):
            print('缺原图 ' + str(i))
            continue
        src = load(src_path)

        paths = {
            'A_最初(12~45KB)': os.path.join('_diag/wall_originals', name),
            'B_上轮(残图恢复)': os.path.join('_diag/wall_v2', name),
            'C_本轮(原图直编)': os.path.join('public/static/img/wall', name),
        }

        rec = {'i': i, '原图': src.size}
        for tag, p in paths.items():
            if not os.path.exists(p):
                rec[tag] = None
                continue
            im = load(p)
            same_size = (im.size == src.size)
            # PSNR 必须在同尺寸下算，尺寸不同先缩放到原图尺寸
            cmp_im = im if same_size else im.resize(src.size, Image.LANCZOS)
            rec[tag] = {
                'kb': os.path.getsize(p) / 1024,
                'size': im.size,
                'sharp': laplacian_var(im),
                'psnr': psnr(src, cmp_im),
                'bri': float(gray(np.asarray(im, dtype=np.float64)).mean()),
            }
        rows.append(rec)

    print('\n%-4s %-12s %10s %10s %10s %10s' %
          ('#', '版本', '体积KB', '锐度', 'PSNR(dB)', '亮度均值'))
    print('-' * 66)
    for r in rows:
        for tag in ('A_最初(12~45KB)', 'B_上轮(残图恢复)', 'C_本轮(原图直编)'):
            v = r.get(tag)
            if not v:
                print('%-4s %-12s %10s' % ('%02d' % r['i'], tag, '(无)'))
                continue
            print('%-4s %-12s %10.1f %10.1f %10.2f %10.1f' %
                  ('%02d' % r['i'], tag, v['kb'], v['sharp'], v['psnr'], v['bri']))
        print()

    # ---- 汇总断言 ----
    pairs = [(r['A_最初(12~45KB)'], r['C_本轮(原图直编)'], r['i']) for r in rows
             if r.get('A_最初(12~45KB)') and r.get('C_本轮(原图直编)')]
    ok = True

    min_sharp_gain = min(c['sharp'] / max(a['sharp'], 1e-6) for a, c, _ in pairs)
    med_sharp_gain = sorted(c['sharp'] / max(a['sharp'], 1e-6) for a, c, _ in pairs)[len(pairs) // 2]
    print('锐度提升：最小 %.1f 倍，中位 %.1f 倍' % (min_sharp_gain, med_sharp_gain))
    # 倍数差异由内容决定（花枝那种大片虚化的构图，细节本来就少，
    # 提升空间只有一倍多；星月夜/卡通插画能到几十倍）。
    # 所以看两头：最差的一张也不能低于 1.5 倍，中位数不低于 2.5 倍。
    if min_sharp_gain < 1.5:
        print('  ✗ 有样本锐度几乎没变（<1.5 倍）')
        ok = False
    elif med_sharp_gain < 2.5:
        print('  ✗ 中位提升不足 2.5 倍')
        ok = False
    else:
        print('  ✓ 每张都明显更锐（最低 %.1f 倍），中位 %.1f 倍' % (min_sharp_gain, med_sharp_gain))

    min_psnr = min(c['psnr'] for _, c, _ in pairs)
    max_old_psnr = max(a['psnr'] for a, _, _ in pairs)
    print('PSNR：本轮最低 %.2fdB，旧版最高 %.2fdB' % (min_psnr, max_old_psnr))
    if min_psnr < 34:
        print('  ✗ 有样本与原图差距过大（<34dB 已能看出块效应）')
        ok = False
    elif min_psnr <= max_old_psnr:
        print('  ✗ 新版没能全面超过旧版')
        ok = False
    else:
        print('  ✓ 全部样本都比旧版更接近原图（最低也高于旧版最好的一张）')

    total = sum(r['C_本轮(原图直编)']['kb'] for r in rows if r.get('C_本轮(原图直编)'))
    print('本轮壁纸合计 %.2fMB' % (total / 1024))
    if total / 1024 > 5:
        print('  ✗ 总体积超过 5MB，首屏负担过重')
        ok = False
    else:
        print('  ✓ 总体积在 5MB 以内')

    print('\n' + ('全部通过' if ok else '存在未通过项'))
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
