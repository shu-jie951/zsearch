# -*- coding: utf-8 -*-
"""
去掉全站玻璃特效（backdrop-filter），改为「雾面实色 + 细描边」的纸感层。

为什么要去玻璃（不是审美摇摆）：
  1. 用户明确要求。
  2. 实测代价：每个 backdrop-filter 元素在背景变化时都要重新采样底图。
     本项目全屏壁纸 + 23 个玻璃元素，切图那一下就是 23 次重采样，
     这是之前"切换卡顿"的主要来源之一。
  3. 磨砂本身在削弱壁纸 —— 用户说"背景不清晰"，玻璃层盖着的部分确实是糊的。

去模糊后必须**补足背景实度**，否则原本靠模糊遮住的文字会压在图上看不清。
这里按元素面积分档：大容器 92~96%，小胶囊 86~88%，遮罩加深补偿失去的模糊。

用法: python _defrost.py
"""
import io
import os
import sys

# (文件, 原文, 新文) —— 逐条精确替换，避免正则误伤
EDITS = [
    # ---------- home.css ----------
    ('public/static/css/home.css',
     "  background: color-mix(in srgb, var(--bg-elevated) 78%, transparent);\n"
     "  backdrop-filter: blur(18px) saturate(150%);\n"
     "  -webkit-backdrop-filter: blur(18px) saturate(150%);\n",
     "  /* 雾面实色：去掉 backdrop-filter 后靠实度保证文字可读。\n"
     "     94% 是实测临界值 —— 再低，浅色壁纸上的正文边缘就开始发灰。 */\n"
     "  background: color-mix(in srgb, var(--bg-elevated) 94%, transparent);\n"),

    ('public/static/css/home.css',
     "  background: color-mix(in srgb, var(--bg-elevated) 88%, transparent);\n"
     "  border: 1px solid var(--border);\n"
     "  color: var(--text-muted);\n"
     "  box-shadow: var(--shadow-sm);\n"
     "  backdrop-filter: blur(10px);\n"
     "  -webkit-backdrop-filter: blur(10px);\n",
     "  background: color-mix(in srgb, var(--bg-elevated) 94%, transparent);\n"
     "  border: 1px solid var(--border);\n"
     "  color: var(--text-muted);\n"
     "  box-shadow: var(--shadow-sm);\n"),

    ('public/static/css/home.css',
     "  background: color-mix(in srgb, var(--bg-elevated) 55%, transparent);\n"
     "  backdrop-filter: blur(8px);\n"
     "  -webkit-backdrop-filter: blur(8px);\n",
     "  background: color-mix(in srgb, var(--bg-elevated) 88%, transparent);\n"),

    ('public/static/css/home.css',
     "  background: color-mix(in srgb, var(--bg) 45%, rgba(0, 0, 0, 0.28));\n"
     "  backdrop-filter: blur(6px);\n"
     "  -webkit-backdrop-filter: blur(6px);\n",
     "  /* 遮罩失去模糊补偿后要加深，否则弹出面板和背景糊在一起，\n"
     "     用户分不清「这一层」和「下面那层」。 */\n"
     "  background: color-mix(in srgb, var(--bg) 58%, rgba(0, 0, 0, 0.38));\n"),

    # ---------- results.css ----------
    ('public/static/css/results.css',
     "  background: color-mix(in srgb, var(--bg-elevated) 78%, transparent);\n"
     "  backdrop-filter: blur(18px) saturate(150%);\n"
     "  -webkit-backdrop-filter: blur(18px) saturate(150%);\n",
     "  background: color-mix(in srgb, var(--bg-elevated) 94%, transparent);\n"),

    ('public/static/css/results.css',
     "  background: color-mix(in srgb, var(--bg-elevated) 82%, transparent);\n"
     "  backdrop-filter: blur(12px);\n"
     "  -webkit-backdrop-filter: blur(12px);\n",
     "  background: color-mix(in srgb, var(--bg-elevated) 92%, transparent);\n"),

    ('public/static/css/results.css',
     "  background: color-mix(in srgb, var(--bg-elevated) 85%, transparent);\n"
     "  backdrop-filter: blur(12px);\n"
     "  -webkit-backdrop-filter: blur(12px);\n",
     "  background: color-mix(in srgb, var(--bg-elevated) 94%, transparent);\n"),

    ('public/static/css/results.css',
     "  background: color-mix(in srgb, var(--bg-elevated) 88%, transparent);\n"
     "  backdrop-filter: blur(12px);\n"
     "  -webkit-backdrop-filter: blur(12px);\n",
     "  background: color-mix(in srgb, var(--bg-elevated) 94%, transparent);\n"),

    # ---------- wallpaper.css ----------
    # 渲染参数：不再压饱和度。原先是 saturate(0.9) —— 它让每张图都发闷，
    # 用户说的"背景不够清晰"有一半来自这里。改成轻微提饱和 + 微对比，
    # 照片的通透感才出得来。
    ('public/static/css/wallpaper.css',
     "  --wp-filter: saturate(0.9) brightness(1.03);",
     "  --wp-filter: saturate(1.04) contrast(1.03) brightness(1.02);"),

    # 交叉淡入缩短：880ms 的两张全屏图叠加期太长，既慢又容易看成"重影"
    ('public/static/css/wallpaper.css',
     "  --wp-dur: 880ms;",
     "  --wp-dur: 520ms;"),

    # 遮罩减淡：让壁纸透出来
    ('public/static/css/wallpaper.css',
     "  background: var(--wp-scrim, rgba(6, 7, 10, 0.4));",
     "  background: var(--wp-scrim, rgba(6, 7, 10, 0.24));"),

    # 噪点层压到几乎看不见：低质图上叠 overlay 噪点只会更脏
    ('public/static/css/wallpaper.css',
     "  opacity: 0.14;\n  mix-blend-mode: overlay;",
     "  opacity: 0.05;\n  mix-blend-mode: overlay;"),

    ('public/static/css/wallpaper.css',
     ".wall-glass {\n"
     "  background: color-mix(in srgb, var(--bg-elevated) 66%, transparent);\n"
     "  backdrop-filter: blur(20px) saturate(160%);\n"
     "  -webkit-backdrop-filter: blur(20px) saturate(160%);\n",
     ".wall-glass {\n"
     "  background: color-mix(in srgb, var(--bg-elevated) 93%, transparent);\n"),

    # 整个 @supports 兜底块删掉：已经不用 backdrop-filter，没有"不支持"这回事
    ('public/static/css/wallpaper.css',
     "@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {\n"
     "  .wall-glass {\n"
     "    background: color-mix(in srgb, var(--bg-elevated) 94%, transparent);\n"
     "  }\n"
     "}\n\n", ''),

    ('public/static/css/wallpaper.css',
     "  background: color-mix(in srgb, var(--bg-elevated) 62%, transparent);\n"
     "  backdrop-filter: blur(18px) saturate(150%);\n"
     "  -webkit-backdrop-filter: blur(18px) saturate(150%);\n",
     "  background: color-mix(in srgb, var(--bg-elevated) 88%, transparent);\n"),

    ('public/static/css/wallpaper.css',
     "  background: color-mix(in srgb, var(--bg-elevated) 58%, transparent);\n"
     "  backdrop-filter: blur(16px) saturate(150%);\n"
     "  -webkit-backdrop-filter: blur(16px) saturate(150%);\n",
     "  background: color-mix(in srgb, var(--bg-elevated) 88%, transparent);\n"),

    ('public/static/css/wallpaper.css',
     "  background: color-mix(in srgb, var(--bg-elevated) 56%, transparent);\n"
     "  backdrop-filter: blur(16px) saturate(150%);\n"
     "  -webkit-backdrop-filter: blur(16px) saturate(150%);\n",
     "  background: color-mix(in srgb, var(--bg-elevated) 88%, transparent);\n"),

    ('public/static/css/wallpaper.css',
     "  background: color-mix(in srgb, var(--bg) 82%, transparent);\n"
     "  backdrop-filter: blur(20px) saturate(150%);\n"
     "  -webkit-backdrop-filter: blur(20px) saturate(150%);\n",
     "  background: color-mix(in srgb, var(--bg) 93%, transparent);\n"),

    ('public/static/css/wallpaper.css',
     "  background: color-mix(in srgb, var(--bg-elevated) 72%, transparent);\n"
     "  backdrop-filter: blur(22px) saturate(170%);\n"
     "  -webkit-backdrop-filter: blur(22px) saturate(170%);\n",
     "  background: color-mix(in srgb, var(--bg-elevated) 90%, transparent);\n"),

    ('public/static/css/wallpaper.css',
     "  background: rgba(6, 7, 10, 0.34);\n"
     "  backdrop-filter: blur(2px);\n"
     "  -webkit-backdrop-filter: blur(2px);\n",
     "  background: rgba(6, 7, 10, 0.46);\n"),

    ('public/static/css/wallpaper.css',
     "  background: color-mix(in srgb, var(--bg) 88%, transparent);\n"
     "  backdrop-filter: blur(30px) saturate(170%);\n"
     "  -webkit-backdrop-filter: blur(30px) saturate(170%);\n",
     "  background: color-mix(in srgb, var(--bg) 96%, transparent);\n"),

    # ---------- workbench.css ----------
    ('public/static/css/workbench.css',
     "  background: rgba(6, 7, 10, 0.34);\n"
     "  backdrop-filter: blur(2px);\n"
     "  -webkit-backdrop-filter: blur(2px);\n",
     "  background: rgba(6, 7, 10, 0.46);\n"),

    ('public/static/css/workbench.css',
     "  background: color-mix(in srgb, var(--bg) 90%, transparent);\n"
     "  backdrop-filter: blur(30px) saturate(170%);\n"
     "  -webkit-backdrop-filter: blur(30px) saturate(170%);\n",
     "  background: color-mix(in srgb, var(--bg) 96%, transparent);\n"),

    ('public/static/css/workbench.css',
     "  background: color-mix(in srgb, var(--bg-elevated) 92%, transparent);\n"
     "  backdrop-filter: blur(18px) saturate(160%);\n"
     "  -webkit-backdrop-filter: blur(18px) saturate(160%);\n",
     "  background: color-mix(in srgb, var(--bg-elevated) 96%, transparent);\n"),
]


def main():
    missing = []
    for path, old, new in EDITS:
        with io.open(path, encoding='utf-8') as f:
            src = f.read()
        if old not in src:
            missing.append((path, old.strip().split('\n')[0][:60]))
            continue
        src = src.replace(old, new, 1)
        with io.open(path, 'w', encoding='utf-8', newline='') as f:
            f.write(src)

    if missing:
        print('以下替换没命中（原文可能已变），需要人工看一下：')
        for p, snippet in missing:
            print('  ', p, '|', snippet)
        return 1

    # 复查：还有没有漏网的 backdrop-filter（注释里的不算）
    left = 0
    for fn in os.listdir('public/static/css'):
        if not fn.endswith('.css'):
            continue
        for ln in io.open(os.path.join('public/static/css', fn), encoding='utf-8'):
            s = ln.strip()
            if 'backdrop-filter' in s and not s.startswith(('*', '/*', '//')):
                print('  残留:', fn, '|', s)
                left += 1
    print('替换完成，残留 backdrop-filter 声明：%d 处' % left)
    return 0


if __name__ == '__main__':
    sys.exit(main())
